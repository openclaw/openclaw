// Secretless product-path diagnostic, not a Telegram Test Server/live-service proof.
// Usage: node --import <repo>/scripts/tsx.mjs <script> --repo <checkout>
//   --mode baseline|candidate --output-dir <owned-proof-parent>
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { finalizeManagedChild, loadManagedChildSpawner } from "./lib/managed-child-process.mts";

const spawnChild = await loadManagedChildSpawner();
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `Required ${name}`);
  return args[index + 1];
};
const repo = path.resolve(option("--repo"));
const mode = option("--mode");
assert.ok(["baseline", "candidate"].includes(mode), "--mode must be baseline or candidate");
const outputDir = path.resolve(option("--output-dir"));
await fs.mkdir(outputDir, { recursive: true });
const root = await fs.mkdtemp(path.join(outputDir, `cross-plugin-${mode}-`));
const stateDir = path.join(root, "state");
const configPath = path.join(root, "openclaw.json");
const marker = `RECOVERYPROOF${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
const text = {
  t1: `${marker}T1`,
  t2: `${marker}T2`,
  q: `${marker}QA`,
  control: `${marker}CONTROL`,
};
const gatewayToken = "owned-secretless-recovery-gateway-fixture";
const botToken = "123456:secretless-recovery-http-fixture";
const bot = {
  id: 123456,
  is_bot: true,
  first_name: "Recovery fixture",
  username: "owned_recovery_fixture_bot",
};
const peer = { id: 700001, type: "private", first_name: "Synthetic user" };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const moduleAt = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const cancellation = new AbortController();
const pause = (ms) =>
  delay(ms, undefined, cleaningUp ? undefined : { signal: cancellation.signal });
const interrupt = () => cancellation.abort(new Error("Recovery proof interrupted"));
// Keep the driver alive to run its existing teardown, including detached groups.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const evidence = {
  mode,
  events: [],
  stages: [],
  botApiMethods: {},
  limitations: [
    "Actual Gateway, Telegram plugin and qa-channel plugin with synthetic loopback HTTP services",
    "No Telegram Test Server, Convex lease, TDLib observer, hosted provider or enterprise incident",
    "Finite five-second response delay; no cancellation or exactly-once guarantee is inferred",
    "Forced task-owned process replacement proves crash/restart recovery, not orderly shutdown",
  ],
};
let phase = "registration",
  gateway,
  client,
  capture = "",
  telegram,
  qaProxy,
  qaBus;
let telegramPort,
  qaPort,
  delayed = false,
  telegramMessageId = 0,
  fatalFixtureError,
  cleaningUp = false;
const updates = [],
  children = [],
  ownedProcesses = new Set(),
  processLifecycles = new WeakMap(),
  activeRequests = new Set();
const stage = (name) => {
  evidence.stages.push({ name, at: Date.now() });
  console.log(name);
};
Object.assign(process.env, { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath });
const env = {
  ...process.env,
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
};
for (const name of Object.keys(env)) {
  if (
    /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_OPTIONS|CODEX_HOME|OPENCLAW_GATEWAY_URL|OPENCLAW_GATEWAY_PORT|OPENCLAW_TEST_MINIMAL_GATEWAY|OPENCLAW_SKIP_CHANNELS|OPENCLAW_SKIP_PROVIDERS)$/.test(
      name,
    )
  ) {
    delete env[name];
  }
}
async function until(label, predicate, timeoutMs = 45_000) {
  // Teardown must still verify closure after the workload's deadline expires.
  const end = cleaningUp ? Date.now() + timeoutMs : Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < end) {
    if (fatalFixtureError && !cleaningUp) {
      throw fatalFixtureError;
    }
    if (gateway && (gateway.exitCode !== null || gateway.signalCode !== null)) {
      throw new Error(`Gateway exited while ${label}`);
    }
    const result = await predicate();
    if (result) {
      return result;
    }
    await pause(100);
  }
  throw new Error(`Missing proof/setup before deadline: ${label}`);
}
async function bind(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function unusedPort() {
  const server = net.createServer();
  const port = await bind(server);
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}
function launch(cliArgs) {
  cancellation.signal.throwIfAborted();
  const child = spawnChild(process.execPath, ["openclaw.mjs", ...cliArgs], {
    cwd: repo,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownedProcesses.add(child);
  children.push(child.pid);
  const lifecycle = { closed: false, finalization: undefined };
  processLifecycles.set(child, lifecycle);
  child.once("close", () => (lifecycle.closed = true));
  return child;
}
async function terminate(child, { crash = false } = {}) {
  if (!child) {
    return;
  }
  const lifecycle = processLifecycles.get(child);
  assert.ok(lifecycle, "Only proof-owned child processes may be stopped");
  // Join one teardown even when validation's timeout races its finally block.
  // A leader exit alone does not retire ownership of its descendants or pipes.
  lifecycle.finalization ??= finalizeManagedChild(
    child,
    crash
      ? "SIGKILL"
      : child.exitCode !== null || child.signalCode !== null
        ? undefined
        : "SIGTERM",
    {
      platform: process.platform,
      runTaskkill: spawnSync,
      forceKillDelayMs: 5000,
      drainTimeoutMs: 5000,
      isChildClosed: () => lifecycle.closed,
    },
  ).then(() => ownedProcesses.delete(child));
  await lifecycle.finalization;
}
async function validateConfig() {
  const child = launch(["config", "validate", "--json"]);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (b) => (output += b));
  }
  try {
    const [code, signal] = await once(child, "exit", {
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(45_000)]),
    });
    evidence.configValidation = { code, signal, output };
    assert.equal(code, 0, output);
  } finally {
    await terminate(child);
  }
}
async function requestFields(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    assert.ok(bytes <= 1024 * 1024, "Fixture body too large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return Object.fromEntries(new URL(req.url, "http://fixture").searchParams);
  }
  return String(req.headers["content-type"]).includes("application/json")
    ? JSON.parse(body)
    : Object.fromEntries(new URLSearchParams(body));
}
function fixtureServer(handle) {
  const server = http.createServer((req, res) => {
    const work = handle(req, res).catch((error) => {
      if (!server.proofClosing) {
        fatalFixtureError = error;
      }
      res.destroy(error);
    });
    activeRequests.add(work);
    void work.finally(() => activeRequests.delete(work));
  });
  return server;
}
const json = (res, result) => {
  if (!res.destroyed) {
    res
      .writeHead(200, { "content-type": "application/json", connection: "close" })
      .end(JSON.stringify({ ok: true, result }));
  }
};
async function openTelegram() {
  telegram = fixtureServer(async (req, res) => {
    const method = new URL(req.url, "http://fixture").pathname.split("/").at(-1);
    const fields = await requestFields(req);
    evidence.botApiMethods[method] = (evidence.botApiMethods[method] ?? 0) + 1;
    if (method === "getMe") {
      return json(res, bot);
    }
    if (method === "getWebhookInfo") {
      return json(res, { url: "", has_custom_certificate: false, pending_update_count: 0 });
    }
    if (method === "getUpdates") {
      const pending = updates.filter((update) => update.update_id >= Number(fields.offset ?? 0));
      if (!pending.length) {
        await pause(250);
      }
      return json(res, pending);
    }
    if (method === "getMyCommands") {
      return json(res, []);
    }
    if (method === "getUserProfilePhotos") {
      return json(res, { total_count: 0, photos: [] });
    }
    if (method === "getChat") {
      return json(res, peer);
    }
    if (method === "getChatMember") {
      return json(res, { status: "member", user: bot });
    }
    if (method === "sendMessage" || method === "editMessageText") {
      const event = {
        phase,
        channel: "telegram",
        text: fields.text,
        requestedAt: Date.now(),
        finiteDelayMs: delayed && [text.t1, text.t2].includes(fields.text) ? 5000 : 0,
      };
      evidence.events.push(event);
      res.once("finish", () => {
        event.responseAt = Date.now();
      });
      if (event.finiteDelayMs) {
        await pause(event.finiteDelayMs);
      }
      return json(res, {
        message_id: ++telegramMessageId,
        date: Math.floor(Date.now() / 1000),
        from: bot,
        chat: peer,
        text: fields.text,
      });
    }
    assert.ok(
      [
        "deleteWebhook",
        "setMyCommands",
        "deleteMyCommands",
        "setChatMenuButton",
        "sendChatAction",
        "deleteMessage",
        "answerCallbackQuery",
      ].includes(method),
      `Unexpected Bot API method: ${method}`,
    );
    return json(res, true);
  });
  telegramPort = await bind(telegram, telegramPort);
}
async function openQaProxy() {
  const target = new URL(qaBus.baseUrl);
  qaProxy = fixtureServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let event;
    if (req.url === "/v1/outbound/message") {
      const fields = JSON.parse(body.toString());
      event = {
        phase,
        channel: "qa-channel",
        text: fields.text,
        requestedAt: Date.now(),
        finiteDelayMs: 0,
      };
      evidence.events.push(event);
      res.once("finish", () => {
        event.responseAt = Date.now();
      });
    }
    await new Promise((resolve, reject) => {
      const forward = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
          reply.once("end", resolve);
          reply.once("error", reject);
        },
      );
      // The channel may cancel an idle poll while its account restarts. That
      // closes this request, not the fixture or any recorded outbound send.
      res.once("close", () => {
        if (!res.writableEnded) {
          forward.destroy();
          resolve();
        }
      });
      forward.once("error", (error) => {
        if (res.destroyed) {
          resolve();
        } else {
          reject(new Error("QA proxy forwarding failed", { cause: error }));
        }
      });
      forward.end(body);
    });
  });
  qaPort = await bind(qaProxy, qaPort);
}
async function stopGateway(options) {
  await client?.stopAndWait({ timeoutMs: 1000 });
  client = null;
  const stopped = gateway;
  gateway = null;
  await terminate(stopped, options);
  if (gatewayPort !== undefined) {
    await until(
      "owned Gateway listener closed",
      async () => {
        try {
          await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, {
            signal: AbortSignal.timeout(500),
          });
          return false;
        } catch {
          return true;
        }
      },
      5000,
    );
  }
}
async function offlineRows() {
  assert.equal(gateway, null, "Never inspect a foreign live state writer");
  const { loadUnfinishedDeliveries } = await moduleAt(
    "src/infra/outbound/delivery-queue-storage.ts",
  );
  const { closeOpenClawStateDatabaseAsync } = await moduleAt("src/state/openclaw-state-db.js");
  try {
    return await loadUnfinishedDeliveries(stateDir);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}
async function closeServer(server) {
  if (!server?.listening) {
    return;
  }
  server.proofClosing = true;
  await busApi.closeQaHttpServer(server);
}
async function startGateway() {
  stage(`Gateway start: ${phase}`);
  gateway = launch(["gateway", "run", "--port", String(gatewayPort), "--bind", "loopback"]);
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on("data", (b) => {
      capture += b;
    });
  }
  await until(
    "Gateway readiness",
    async () => {
      try {
        return (
          (
            await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok &&
          (
            await fetch(`http://127.0.0.1:${gatewayPort}/startupz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        );
      } catch {
        return false;
      }
    },
    120_000,
  );
  const { connectTestGatewayClient } = await moduleAt(
    "src/gateway/gateway-cli-backend.live-helpers.ts",
  );
  client = await connectTestGatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}`,
    token: gatewayToken,
    requestTimeoutMs: 45_000,
  });
  await until("Telegram and QA accounts ready", async () => {
    const status = await client.request("channels.status", { probe: false, timeoutMs: 2000 });
    return ["telegram", "qa-channel"].every((channel) =>
      status.channelAccounts?.[channel]?.some(
        (account) =>
          account.accountId === "default" &&
          account.running &&
          account.lifecycle === "ready" &&
          account.connected !== false,
      ),
    );
  });
}
const busApi = await moduleAt("extensions/qa-lab/api.ts");
// Module loading is preparation; retain the bounded budget for the actual workload.
const deadline = Date.now() + 240_000;
let gatewayPort;
const stampPaths = ["dist/.buildstamp", "dist/.runtime-postbuildstamp"];
const artifactPaths = [...stampPaths, "dist/entry.js"];
const buildBytes = new Map();
try {
  for (const rel of artifactPaths) {
    buildBytes.set(rel, await fs.readFile(path.join(repo, rel)));
  }
  const buildStamp = JSON.parse(buildBytes.get(stampPaths[0]).toString());
  const runtimeStamp = JSON.parse(buildBytes.get(stampPaths[1]).toString());
  assert.ok(
    buildStamp.head && buildStamp.inputSignature,
    "Build producer identity is required, not current Git HEAD alone",
  );
  if (mode === "baseline") {
    assert.equal(buildStamp.inputsClean, true, "Baseline must identify a clean-input build");
  }
  evidence.testedBuild = {
    buildStamp,
    runtimeStamp,
    artifacts: Object.fromEntries([...buildBytes].map(([rel, bytes]) => [rel, sha256(bytes)])),
  };
  evidence.currentSource = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    diffSha256: sha256(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: repo })),
  };
  gatewayPort = await unusedPort();
  qaBus = await busApi.startQaBusServer({ state: busApi.createQaBusState() });
  await openTelegram();
  await openQaProxy();
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  const config = {
    update: { checkOnStart: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
      reload: { mode: "off" },
    },
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        skipBootstrap: true,
        contextInjection: "never",
        thinkingDefault: "off",
      },
    },
    models: { mode: "replace", providers: {}, catalogRefresh: { enabled: false } },
    plugins: {
      allow: ["telegram", "qa-channel"],
      entries: { telegram: { enabled: true }, "qa-channel": { enabled: true } },
      slots: { memory: "none" },
    },
    channels: {
      telegram: {
        enabled: true,
        botToken,
        apiRoot: `http://127.0.0.1:${telegramPort}`,
        dmPolicy: "allowlist",
        allowFrom: [String(peer.id)],
        streaming: { mode: "off" },
        richMessages: false,
      },
      "qa-channel": {
        enabled: true,
        baseUrl: `http://127.0.0.1:${qaPort}`,
        botUserId: "openclaw",
        allowFrom: ["*"],
        pollTimeoutMs: 1000,
      },
    },
    skills: { allowBundled: [], load: { watch: false } },
    tools: { deny: ["*"] },
    logging: { level: "debug", file: path.join(root, "gateway.log") },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await validateConfig();
  await startGateway();
  stage("Native Telegram and QA /help registration; no model inference required");
  updates.push({
    update_id: 1001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: peer.id, is_bot: false, first_name: peer.first_name },
      chat: peer,
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
  });
  await until("Telegram help response", () =>
    evidence.events.some((e) => e.channel === "telegram" && e.responseAt),
  );
  const response = await fetch(`${qaBus.baseUrl}/v1/inbound/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "default",
      conversation: { id: "qa-peer", kind: "direct" },
      senderId: "qa-peer",
      text: "/help",
      nativeCommand: { name: "help" },
    }),
  });
  assert.equal(response.status, 200);
  await until("QA help response", () =>
    evidence.events.some((e) => e.channel === "qa-channel" && e.responseAt),
  );
  const listed = await client.request("conversations.list", { agentId: "main", limit: 100 });
  evidence.registeredConversations = listed.conversations;
  const telegramRef = listed.conversations.find(
    (c) =>
      c.channel === "telegram" && c.accountId === "default" && c.target === `telegram:${peer.id}`,
  )?.conversationRef;
  const qaRef = listed.conversations.find(
    (c) => c.channel === "qa-channel" && c.accountId === "default" && c.target === "dm:qa-peer",
  )?.conversationRef;
  assert.ok(
    telegramRef && qaRef,
    "Both targets must come from actual native ingress, not seeded registry rows",
  );
  phase = "pre-connect-refusal";
  await closeServer(telegram);
  telegram = null;
  await closeServer(qaProxy);
  qaProxy = null;
  evidence.initialSends = [];
  for (const [id, conversationRef] of [
    ["t1", telegramRef],
    ["q", qaRef],
    ["t2", telegramRef],
  ]) {
    const result = await client.request("conversations.send", {
      agentId: "main",
      operationId: `${marker}${id}`,
      conversationRef,
      message: text[id],
    });
    assert.equal(result.status, "queued", `Expected native pre-connect failure to retain ${id}`);
    evidence.initialSends.push({ id, result });
  }
  // This one transition deliberately bypasses graceful shutdown to test durable crash recovery.
  evidence.crashInjection = { pid: gateway.pid, signal: "SIGKILL" };
  await stopGateway({ crash: true });
  const before = await offlineRows();
  evidence.before = before;
  assert.equal(before.length, 3);
  assert.deepEqual(
    new Set(before.map((row) => row.id)),
    new Set(evidence.initialSends.map((send) => send.result.queueId)),
  );
  assert.ok(before.every((row) => row.deliveryCompletion?.kind === "conversation"));
  const { isDeliveryRecoveryRetryEligible } = await moduleAt(
    "src/infra/delivery-recovery.shared.ts",
  );
  const waitMs = Math.max(
    0,
    ...before.map((row) => {
      const eligibility = isDeliveryRecoveryRetryEligible(row, Date.now());
      return eligibility.eligible ? 0 : eligibility.remainingBackoffMs;
    }),
  );
  assert.ok(
    waitMs < 30_000,
    "Unexpected initial retry budget; preserve setup facts instead of editing retry state",
  );
  evidence.naturalRetryWaitMs = waitMs;
  await pause(waitMs + 100);
  delayed = true;
  phase = "automatic-recovery";
  await openTelegram();
  await openQaProxy();
  const recoveryLogStart = capture.length;
  await startGateway();
  const eventFor = (id) =>
    evidence.events.find((event) => event.phase === phase && event.text === text[id]);
  const t1 = await until("first Telegram recovery request", () => eventFor("t1"));
  assert.equal(
    t1.responseAt,
    undefined,
    "Need a still-pending finite Telegram send for the foreground control",
  );
  const controlStart = Date.now();
  evidence.healthyForegroundControl = await client.request("conversations.send", {
    agentId: "main",
    operationId: `${marker}control`,
    conversationRef: qaRef,
    message: text.control,
  });
  evidence.healthyForegroundControlMs = Date.now() - controlStart;
  assert.equal(evidence.healthyForegroundControl.status, "sent");
  assert.equal(
    t1.responseAt,
    undefined,
    "Healthy foreground control must complete while slow recovery is pending",
  );
  await until("all exact recovery HTTP responses", () =>
    ["t1", "q", "t2"].every((id) => eventFor(id)?.responseAt),
  );
  const q = eventFor("q"),
    t2 = eventFor("t2");
  evidence.metrics = {
    telegramFirstHttpMs: t1.responseAt - t1.requestedAt,
    telegramSecondHttpMs: t2.responseAt - t2.requestedAt,
    healthyQaHttpMs: q.responseAt - q.requestedAt,
    qaStartAfterFirstTelegramStartMs: q.requestedAt - t1.requestedAt,
    qaStartAfterFirstTelegramResponseMs: q.requestedAt - t1.responseAt,
    secondTelegramStartAfterFirstResponseMs: t2.requestedAt - t1.responseAt,
  };
  assert.ok(t2.requestedAt >= t1.responseAt, "Same Telegram domain must not overlap or reorder");
  if (mode === "baseline") {
    assert.ok(q.requestedAt >= t1.responseAt, "Baseline defect was not reproduced");
  } else {
    assert.ok(
      q.responseAt < t1.responseAt,
      "Healthy queued QA must settle while Telegram remains pending",
    );
  }
  await until(
    "positive recovery logs for original queue IDs",
    () =>
      before.every((row) => {
        return [`drained delivery ${row.id}`, `Recovered delivery ${row.id}`].some((message) =>
          capture.includes(message, recoveryLogStart),
        );
      }),
    8000,
  );
  await stopGateway();
  evidence.after = await offlineRows();
  assert.equal(evidence.after.length, 0);
  for (const id of ["t1", "q", "t2", "control"]) {
    assert.equal(
      evidence.events.filter((event) => event.phase === phase && event.text === text[id]).length,
      1,
      `Exact target ${id} once`,
    );
  }
  for (const [rel, bytes] of buildBytes) {
    assert.ok(
      bytes.equals(await fs.readFile(path.join(repo, rel))),
      `Tested build changed during proof: ${rel}`,
    );
  }
  evidence.status =
    mode === "baseline"
      ? "confirmed-cross-plugin-recovery-blocking"
      : "confirmed-cross-plugin-recovery-isolation";
  stage(evidence.status);
} catch (error) {
  evidence.status = "failed";
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(evidence.error);
} finally {
  cleaningUp = true;
  evidence.cleanupErrors = [];
  for (const cleanup of [
    stopGateway,
    ...[...ownedProcesses].map((child) => () => terminate(child)),
    () => closeServer(telegram),
    () => closeServer(qaProxy),
    () => qaBus?.stop(),
    () => Promise.allSettled(activeRequests),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      evidence.cleanupErrors.push(String(error));
      process.exitCode = 1;
    }
  }
  evidence.ownedProcessPids = children;
  evidence.cleanupConfirmed = evidence.cleanupErrors.length === 0 && ownedProcesses.size === 0;
  if (!evidence.cleanupConfirmed) {
    process.exitCode = 1;
  }
  if (cancellation.signal.aborted) {
    evidence.status = "interrupted";
    process.exitCode = 1;
  }
  await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(root, "gateway.log.capture"), capture);
  console.log(
    JSON.stringify({
      root,
      mode,
      status: evidence.status,
      metrics: evidence.metrics,
      cleanupConfirmed: evidence.cleanupConfirmed,
      error: evidence.error?.split("\n")[0],
    }),
  );
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
