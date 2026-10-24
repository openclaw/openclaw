import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import { canonicalBytes, sha256Hex } from "../../extensions/reef/protocol/canonical.js";
import { base64url } from "../../extensions/reef/protocol/encoding.js";
import { bodyHash, seal } from "../../extensions/reef/protocol/envelope.js";
import { generateIdentity } from "../../extensions/reef/protocol/identity.js";
import { stopChild, delay } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  resolveEntry,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string" },
    seconds: { type: "string", default: "90" },
    messages: { type: "string", default: "18" },
    "expired-peer": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
  },
});
if (!values.output || !values.observer) {
  throw new Error("--output and --observer are required");
}
const seconds = Number(values.seconds);
const messageCount = Number(values.messages);
if (
  !Number.isInteger(seconds) ||
  seconds < 30 ||
  !Number.isInteger(messageCount) ||
  messageCount < 0 ||
  messageCount > 100
) {
  throw new Error("seconds must be >=30; messages must be in 0..100");
}
const output = path.resolve(values.output);
mkdirSync(output);
const fixture = path.join(output, "fixture");
mkdirSync(fixture);
const sql = path.join(output, "sql");
mkdirSync(sql);
writeFileSync(path.join(sql, "phase"), "boot");
const receiver = {
  ...generateIdentity(),
  auditKey: base64url(randomBytes(32)),
  replayKey: base64url(randomBytes(32)),
  keyEpoch: 1,
};
const sender = generateIdentity();
const policyVersion = "synthetic-polling-v1";
const envelopes = Array.from({ length: messageCount }, (_, index) => {
  const id = `01J0000000000000000000${String(index).padStart(4, "0")}`;
  const body = { text: "Synthetic pending review for polling measurement." };
  const envelope = seal({
    id,
    from: "sender#1",
    to: "receiver#1",
    body,
    senderSigningSecretKey: sender.signing.secretKey,
    recipientEncryptionPublicKey: receiver.encryption.publicKey,
  });
  const binding = {
    id,
    from: envelope.from,
    to: envelope.to,
    direction: "inbound",
    bodyHash: bodyHash(body),
    policyVersion,
  };
  const approvalDigest = sha256Hex(canonicalBytes(binding));
  return {
    envelope,
    review: {
      ...binding,
      approvalDigest,
      verdict: {
        decision: "review",
        category: "synthetic",
        reason: "Synthetic pending review",
        model: "gpt-5.6-sol",
        policyVersion,
      },
    },
  };
});
let polls = 0;
let acknowledgments = 0;
let unexpectedRequests = 0;
const relay = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/friends") {
    res.end(
      JSON.stringify({
        friendships: [
          {
            peer: "sender",
            status: "active",
            initiated_by: "receiver",
            vouching_mutual: null,
            ed25519_pub: sender.signing.publicKey,
            x25519_pub: sender.encryption.publicKey,
            key_epoch: 1,
          },
        ],
      }),
    );
  } else if (url.pathname === "/v1/mail") {
    polls++;
    const after = Number(url.searchParams.get("after") ?? 0);
    const entries = envelopes
      .map(({ envelope }, index) => ({
        seq: index + 1,
        peer: "sender",
        id: envelope.id,
        kind: "message",
        envelope,
        ts: envelope.ts,
      }))
      .filter((entry) => entry.seq > after);
    res.end(JSON.stringify({ entries, cursor: Math.max(after, messageCount) }));
  } else if (url.pathname.endsWith("/ack")) {
    acknowledgments++;
    res.end(JSON.stringify({ result: "ok" }));
  } else {
    unexpectedRequests++;
    res.writeHead(404).end(JSON.stringify({ error: "unexpected_fixture_request" }));
  }
});
const sockets = new WebSocketServer({ server: relay, path: "/v1/mail/ws" });
sockets.on("connection", (socket) =>
  socket.on("message", (message) => {
    if (
      new TextDecoder().decode(Array.isArray(message) ? Buffer.concat(message) : message) === "ping"
    ) {
      socket.send("pong");
    }
  }),
);
await new Promise<void>((resolve) => {
  relay.listen(0, "127.0.0.1", resolve);
});
try {
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("relay did not bind");
  }
  const relayUrl = `http://127.0.0.1:${address.port}`;
  const port = await getFreePort();
  const configPath = writeGatewayBenchConfig(
    fixture,
    {
      ...BASE_GATEWAY_BENCH_CONFIG,
      plugins: { enabled: true, allow: ["reef"], entries: { reef: { enabled: true } } },
      channels: {
        reef: {
          enabled: true,
          handle: "receiver",
          email: "fixture@example.invalid",
          relayUrl,
          guard: {
            provider: "openai",
            pinnedModel: "gpt-5.6-sol",
            apiKeyEnv: "REEF_SYNTHETIC_KEY",
            policyVersion,
            timeoutMs: 1000,
          },
        },
      },
    },
    {},
  );
  const env = createGatewayBenchEnv(fixture, configPath, {
    caseEnv: {
      NODE_DISABLE_COMPILE_CACHE: "1",
      REEF_SYNTHETIC_KEY: "synthetic-no-network-credential",
    },
  });
  // Seed offline, then close the owner before the Gateway opens the same synthetic state.
  Object.assign(process.env, {
    OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: fixture,
  });
  const { createPluginStateKeyedStoreV2 } =
    await import("../../src/plugin-state/plugin-state-store.ts");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
  try {
    const seed = (
      namespace: string,
      maxEntries: number,
      pluginId = "reef",
      defaultTtlMs?: number,
    ) =>
      createPluginStateKeyedStoreV2(
        pluginId,
        { namespace, maxEntries, overflowPolicy: "reject-new", defaultTtlMs },
        { assertCurrent() {} },
      );
    await seed("identity", 1).register("keys", receiver);
    await seed("registration", 2).register("identity", { handle: "receiver", relayUrl });
    await seed("peer-state", 4096).register(
      `${sha256Hex(new TextEncoder().encode(`${relayUrl}\nreceiver`))}:sender`,
      {
        revision: 1,
        trust: {
          autonomy: "bounded",
          ed25519PublicKey: sender.signing.publicKey,
          x25519PublicKey: sender.encryption.publicKey,
          keyEpoch: 1,
          safetyNumberChanged: false,
          approvedAt: 1,
        },
      },
    );
    const reviews = seed("reviews", 2000);
    for (const { review } of envelopes) {
      await reviews.register(review.approvalDigest, { review });
    }
    if (values["expired-peer"]) {
      await seed("expired", 1, "synthetic-expired-peer", 1).register("expired", {
        synthetic: true,
      });
    }
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
  const networkGuard = path.join(fixture, "loopback-only.mjs");
  writeFileSync(
    networkGuard,
    `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Fixture blocked external fetch");
  return original(input, init);
};\n`,
  );
  const log = openSync(path.join(output, "gateway.log"), "wx");
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(resolveEntry(values.entry, "dist/entry.js"), port, [
      "--import",
      networkGuard,
      ...gatewayBenchCpuProfileArgs(values.profile ? path.join(output, "profiles") : undefined),
    ]),
    {
      env: {
        ...env,
        NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
        SQLMEASURE_OUT: sql,
      },
      stdio: ["ignore", log, log],
      detached: true,
    },
  );
  try {
    const initial = await waitForInitialProbe({
      startAt: performance.now(),
      port,
      path: "/healthz",
      deadlineAt: performance.now() + 120_000,
      isDone: () => child.exitCode !== null || child.signalCode !== null,
    });
    if (initial.status !== 200) {
      throw new Error("Gateway did not become healthy; inspect gateway.log");
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (polls || child.exitCode !== null) {
        break;
      }
      await delay(100);
    }
    if (!polls) {
      throw new Error("Reef never polled the loopback relay; inspect gateway.log");
    }
    // Let initial delivery and the startup reconcile finish before warm polling.
    await delay(40_000);
    const initialPolls = polls;
    writeFileSync(path.join(sql, "phase"), "steady");
    const started = performance.now();
    await delay(seconds * 1000);
    const durationMs = performance.now() - started;
    writeFileSync(path.join(sql, "phase"), "shutdown");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Gateway exited during measurement");
    }
    const result = {
      messageCount,
      expiredPeer: values["expired-peer"],
      durationMs,
      initialPolls,
      steadyPolls: polls - initialPolls,
      acknowledgments,
      unexpectedRequests,
    };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await stopChild(child, { teardownGraceMs: 15_000 });
    closeSync(log);
  }
  const summary = new Map<string, number>();
  let requests = 0;
  let main = 0;
  for (const file of readdirSync(sql).filter((name) => name.endsWith(".jsonl"))) {
    const sites = new Map<number, { method: string; sql: string }>();
    let isMain = false;
    for (const line of readFileSync(path.join(sql, file), "utf8").trim().split("\n")) {
      const row = JSON.parse(line);
      if (row.type === "process") {
        isMain = row.isMainThread;
      } else if (row.type === "site") {
        sites.set(row.id, row);
      } else if (row.type === "request" && row.phase === "steady") {
        requests++;
      } else if (Array.isArray(row) && row[0] === "steady") {
        const site = sites.get(row[1]);
        if (!site || site.method === "prepare") {
          continue;
        }
        const shape = site.sql.replace(/\s+/g, " ").trim();
        summary.set(shape, (summary.get(shape) ?? 0) + 1);
        if (isMain) {
          main++;
        }
      }
    }
  }
  writeFileSync(
    path.join(output, "counts.json"),
    JSON.stringify(
      {
        requests,
        main,
        statements: [...summary.values()].reduce((sum, n) => sum + n, 0),
        shapes: [...summary].toSorted((a, b) => b[1] - a[1]),
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  sockets.close();
  await new Promise<void>((resolve) => {
    relay.close(() => resolve());
  });
}
