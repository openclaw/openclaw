/** Native synthetic ACP binding mismatch reproduction; never operator state. */
// Reproduces only on heads whose generic binding-ID parser truncated conversation ids at
// U+241F; later heads decode B's id, so B's unbind removes B and this mismatch cannot occur.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { isRecord, isStringArray } from "../packages/normalization-core/src/record-coerce.ts";
import { buildAcpDatabaseSessionKey } from "../src/acp/runtime/session-meta-keys.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../src/infra/ed25519-signature.ts";
import { stopChild, stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    out: { type: "string" },
    observer: { type: "string" },
    head: { type: "string" },
    "warm-samples": { type: "string", default: "5" },
    "cpu-profile": { type: "boolean", default: false },
    timing: { type: "boolean", default: false },
    "expect-base": { type: "boolean", default: false },
    "expect-candidate": { type: "boolean", default: false },
  },
});
assert.ok(
  values.repo && values.out && values.observer && values.head,
  "--repo, --out, --observer and --head required",
);
const repo = path.resolve(values.repo);
const output = path.resolve(values.out);
const observer = path.resolve(values.observer);
const warmSamples = Number(values["warm-samples"]);
assert.ok(Number.isSafeInteger(warmSamples) && warmSamples >= 5);
assert.match(values.head, /^[a-f0-9]{40}$/u, "--head must be the built checkout's full commit");
assert.notEqual(
  values["expect-base"],
  values["expect-candidate"],
  "Choose exactly one of --expect-base or --expect-candidate",
);

// The caller owns build provenance, frozen-hash verification, proof slot and timing lock.
// Exclusive creation prevents accidentally opening an existing or live state directory.
mkdirSync(output);
const fixture = path.join(output, "fixture");
const workspace = path.join(fixture, "workspace");
const controlDir = path.join(fixture, "adapter-control");
mkdirSync(workspace, { recursive: true });
mkdirSync(controlDir);
const origin = "https://binding-measure.example.invalid";
const identityName = "binding-measure";
const scopes = ["operator.read", "operator.write", "operator.admin"];
// Keep one sender identity across the cold restart, including its device identity.
const identity = {
  id: "openclaw-control-ui",
  version: "1.0.0",
  platform: process.platform,
  mode: "ui",
};
const keys = generateKeyPairSync("ed25519");
const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
  keys.publicKey.export({ type: "spki", format: "pem" }),
);
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
const configPath = writeGatewayBenchConfig(
  fixture,
  {
    ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      reload: { mode: "off" },
      trustedProxies: ["127.0.0.1"],
      controlUi: { enabled: false, allowedOrigins: [origin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          allowLoopback: true,
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: [identityName],
          deviceAutoApprove: { enabled: true, scopes },
        },
        identityScopes: { [identityName]: scopes },
      },
      roles: {
        default: "administrator",
        definitions: {
          administrator: { agents: "*", sessions: { others: "view" }, scopes },
        },
      },
    },
    agents: { defaults: { skipBootstrap: true } },
    session: { threadBindings: { enabled: true } },
    cron: { enabled: false },
    acp: {
      enabled: true,
      backend: "acpx",
      defaultAgent: "main",
      allowedAgents: ["main"],
      dispatch: { enabled: true },
    },
    plugins: {
      enabled: true,
      allow: ["acpx"],
      entries: {
        acpx: {
          enabled: true,
          config: {
            cwd: workspace,
            stateDir: path.join(fixture, "acpx-state"),
            permissionMode: "deny-all",
            nonInteractivePermissions: "deny",
            agents: {
              main: {
                command: process.execPath,
                args: [
                  "--import",
                  path.join(repo, "node_modules/tsx/dist/loader.mjs"),
                  path.join(repo, "test/fixtures/acp-reset-timeout-adapter.ts"),
                  "--control-dir",
                  controlDir,
                ],
              },
            },
          },
        },
      },
    },
  },
  { agentList: [{ id: "main", workspace }] },
);
const env = createGatewayBenchEnv(fixture, configPath, {
  caseEnv: {
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0",
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repo, "dist/extensions"),
    SQLMEASURE_OUT: output,
    NODE_OPTIONS: `--require=${observer} --enable-source-maps`,
  },
});
assert.ok(env.OPENCLAW_STATE_DIR, "Synthetic state directory was not configured");
const proofDatabasePath = path.join(env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite");
const entry = path.join(repo, "dist/entry.js");
const stopPreload = pathToFileURL(path.join(repo, "scripts/lib/gateway-bench-stop-preload.mjs"));
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", entry);
let phase = "setup";
const phases: Array<{ phase: string; startedAt: number; endedAt: number; load1: number }> = [];
function setPhase(next: string) {
  const now = Date.now();
  const previous = phases.at(-1);
  if (previous) {
    previous.endedAt = now;
  }
  phase = next;
  phases.push({ phase, startedAt: now, endedAt: now, load1: loadavg()[0] ?? 0 });
  writeFileSync(path.join(output, "phase"), phase);
}
let child: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let database: DatabaseSync | undefined;
let log: ReturnType<typeof createWriteStream> | undefined;
let activeBoot: "seed" | "measure" | undefined;
let cleanupPromise: Promise<void> | undefined;
const evidence = {
  ok: false,
  head: values.head,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  warmSamples,
  timing: values.timing,
  nativeSpawns: 0,
  adapterCreates: 0,
  adapterTargets: [] as Array<{ target: string; matchingCreates: number }>,
  restarted: false,
  preserved: 0,
  matchedRemove: false,
  launches: [] as Array<{ boot: string; pid: number }>,
  actions: [] as Array<{ phase: string; latencyMs?: number; physicalTimestampChanged: boolean }>,
  shutdowns: [] as Array<{
    boot: string;
    graceful: boolean;
    forced: boolean;
    exitCode: number | null;
    signal: string | null;
  }>,
};
async function request(method: string, params: unknown) {
  assert.ok(client, "Gateway client is not connected");
  const result = await client.request(method, params, 120_000);
  assert.ok(result.ok, `Native ${method} failed; inspect synthetic gateway log`);
  return result.payload;
}
async function launch(boot: "seed" | "measure") {
  activeBoot = boot;
  setPhase(`${boot}-boot`);
  const port = await getFreePort();
  log = createWriteStream(path.join(output, `${boot}-gateway.log`));
  child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(
      entry,
      port,
      [
        "--import",
        stopPreload.href,
        ...(values["cpu-profile"]
          ? gatewayBenchCpuProfileArgs(path.join(output, "profiles", boot))
          : []),
      ],
      "trusted-proxy",
    ),
    { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  assert.ok(child.pid, "Gateway spawn failed");
  evidence.launches.push({ boot, pid: child.pid });
  const { stdout, stderr } = child;
  assert.ok(stdout && stderr, "Gateway output pipes were not created");
  stdout.pipe(log, { end: false });
  stderr.pipe(log, { end: false });
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });
  const currentChild = child;
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () =>
      Boolean(launchError) || currentChild.exitCode !== null || currentChild.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway did not become ready; inspect synthetic gateway log");
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-proto": "https",
      "x-forwarded-user": identityName,
    },
    onEvent(event) {
      if (
        event.event === "connect.challenge" &&
        isRecord(event.payload) &&
        typeof event.payload.nonce === "string" &&
        typeof event.payload.ts === "number"
      ) {
        challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
      }
    },
  });
  await client.waitOpen();
  const timeout = setTimeout(
    () => challenge.reject(new Error("Device challenge timed out")),
    12_000,
  );
  const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timeout));
  const connected = await request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: identity,
    role: "operator",
    scopes,
    caps: [],
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        privateKey,
        buildDeviceAuthPayloadV3({
          deviceId,
          clientId: identity.id,
          clientMode: identity.mode,
          platform: identity.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          nonce,
        }),
      ),
    },
  });
  assert.ok(isRecord(connected) && isRecord(connected.auth));
  assert.equal(connected.auth.method, "trusted-proxy");
  assert.ok(isStringArray(connected.auth.scopes));
  for (const scope of scopes) {
    assert.ok(connected.auth.scopes.includes(scope), `Gateway did not grant ${scope}`);
  }
}
async function stop() {
  client?.close();
  client = undefined;
  database?.close();
  database = undefined;
  if (!child) {
    return;
  }
  const currentBoot = activeBoot;
  const currentLog = log;
  assert.ok(currentBoot && currentLog, "Gateway launch state is incomplete");
  setPhase(`${currentBoot}-shutdown`);
  const currentChild = child;
  let graceful = false;
  let forced = false;
  try {
    await stopGatewayGracefully(currentChild, 120_000);
    graceful = true;
  } finally {
    const stopped = await stopChild(currentChild, {
      teardownGraceMs: 120_000,
      onForceKill: () => {
        forced = true;
      },
    });
    evidence.shutdowns.push({
      boot: currentBoot,
      graceful,
      forced,
      exitCode: stopped.exitCode,
      signal: stopped.signal,
    });
    child = undefined;
    await new Promise<void>((resolve) => {
      currentLog.end(resolve);
    });
    log = undefined;
    activeBoot = undefined;
  }
}
const a = "agent:main:dashboard:synthetic-a";
const b = `${a}\u241fb`;
type HeldRow = {
  binding_id: string;
  target_session_key: string;
  record_json: string;
  updated_at: number;
};
function row(conversation: string): HeldRow | undefined {
  assert.ok(database, "Synthetic proof database is not open");
  const result = database
    .prepare(`SELECT binding_id, target_session_key, record_json, updated_at
    FROM current_conversation_bindings
    WHERE channel = 'webchat' AND account_id = 'default' AND conversation_kind = 'current'
      AND parent_conversation_id IS NULL AND conversation_id = ?`)
    .get(conversation);
  if (!result) {
    return undefined;
  }
  assert.ok(
    typeof result.binding_id === "string" &&
      typeof result.target_session_key === "string" &&
      typeof result.record_json === "string" &&
      typeof result.updated_at === "number" &&
      Number.isFinite(result.updated_at),
    "Synthetic binding row has an unexpected schema",
  );
  return {
    binding_id: result.binding_id,
    target_session_key: result.target_session_key,
    record_json: result.record_json,
    updated_at: result.updated_at,
  };
}
function openProofDatabase() {
  database = new DatabaseSync(proofDatabasePath, { readOnly: true });
}
function adapterSessionId(targetSessionKey: string): string {
  assert.ok(database, "Synthetic proof database is not open");
  const metadata = database
    .prepare("SELECT identity_json FROM acp_sessions WHERE session_key = ?")
    .get(buildAcpDatabaseSessionKey(targetSessionKey, "main"));
  assert.ok(
    metadata && typeof metadata.identity_json === "string",
    "Binding target has no ACP identity",
  );
  const sessionIdentity: unknown = JSON.parse(metadata.identity_json);
  assert.ok(
    isRecord(sessionIdentity) &&
      typeof sessionIdentity.acpxSessionId === "string" &&
      sessionIdentity.acpxSessionId,
    "Binding target has no backend ACP session ID",
  );
  return sessionIdentity.acpxSessionId;
}
function sameLogicalRow(before: HeldRow, after: HeldRow | undefined) {
  return (
    after !== undefined &&
    before.binding_id === after.binding_id &&
    before.target_session_key === after.target_session_key &&
    before.record_json === after.record_json
  );
}
function messageText(message: Record<string, unknown>) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  const parts: unknown[] = message.content;
  return parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}
async function send(sessionKey: string, message: string, expectedReply: string) {
  const actionPhase = phase;
  const actionStart = values.timing ? performance.now() : undefined;
  const started = await request("chat.send", {
    sessionKey,
    message,
    idempotencyKey: `synthetic-${randomUUID()}`,
    originatingChannel: "webchat",
    originatingTo: sessionKey,
    originatingAccountId: "default",
  });
  assert.ok(
    isRecord(started) && started.status === "started" && typeof started.runId === "string",
    "Native command did not start",
  );
  const settled = await request("agent.wait", { runId: started.runId, timeoutMs: 100_000 });
  assert.ok(
    isRecord(settled) && settled.status === "ok",
    "Native command did not settle successfully",
  );
  const latencyMs = actionStart === undefined ? undefined : performance.now() - actionStart;
  setPhase(`${actionPhase}-proof`);
  const history = await request("chat.history", { sessionKey, limit: 20 });
  assert.ok(isRecord(history) && Array.isArray(history.messages), "Native history has no messages");
  const messages: unknown[] = history.messages;
  const latest = messages.findLast(
    (historyMessage) => isRecord(historyMessage) && historyMessage.role === "assistant",
  );
  assert.ok(
    isRecord(latest) && messageText(latest).includes(expectedReply),
    "Native reply did not confirm action",
  );
  return { phase: actionPhase, latencyMs };
}

type PhaseCounts = {
  sql: number;
  mainSql: number;
  requests: number;
  mainRequests: number;
  failedSql: number;
  unattributedSql: number;
  unattributedRequests: number;
  malformedExecEvents: number;
  sqlCountExact: boolean;
  bindingUpserts: number;
  mainBindingUpserts: number;
  requestsByOperation: Record<string, number>;
  sqlByOperation: Record<string, number>;
  bindingUpsertsByOperation: Record<string, number>;
};
type ObservedSite = { method: string; sql: string; ok: boolean; cause: unknown; stack: string[] };
function summarizeObserver() {
  const filenames = readdirSync(output).filter((name) => /^sql-\d+-\d+\.jsonl$/u.test(name));
  const execShapes = new Set<string>();
  for (const filename of filenames) {
    for (const line of readFileSync(path.join(output, filename), "utf8").split("\n")) {
      if (!line) {
        continue;
      }
      const item: unknown = JSON.parse(line);
      if (isRecord(item) && item.type === "site" && item.method === "exec" && item.ok === true) {
        assert.ok(typeof item.sql === "string");
        execShapes.add(item.sql);
      }
    }
  }
  // Reuse the frozen SQLite-aware splitter once after shutdown; no second SQL parser.
  const splitOutput = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      [
        "import json, sqlite3, sys",
        "sys.path.insert(0, sys.argv[1])",
        "from causal import statements",
        "result = []",
        "for sql in json.load(sys.stdin):",
        "    pieces = statements(sql)",
        "    result.append({'sql': sql, 'pieces': pieces, 'malformed': any(not sqlite3.complete_statement(piece + '\\n;') for piece in pieces)})",
        "json.dump(result, sys.stdout)",
      ].join("\n"),
      path.dirname(observer),
    ],
    { input: JSON.stringify([...execShapes]), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const splitRows: unknown = JSON.parse(splitOutput);
  assert.ok(Array.isArray(splitRows));
  const execStatements = new Map<string, { pieces: string[]; malformed: boolean }>();
  const parsedSplitRows: unknown[] = splitRows;
  for (const item of parsedSplitRows) {
    assert.ok(
      isRecord(item) &&
        typeof item.sql === "string" &&
        isStringArray(item.pieces) &&
        typeof item.malformed === "boolean",
    );
    execStatements.set(item.sql, { pieces: item.pieces, malformed: item.malformed });
  }
  const hasCause = (cause: unknown) =>
    isRecord(cause) && (cause.kind === "turn" || cause.kind === "background");
  const gatewayPids = new Set(evidence.launches.map((item) => item.pid));
  const counts: Record<string, PhaseCounts> = {};
  const phaseCount = (name: string) =>
    (counts[name] ??= {
      sql: 0,
      mainSql: 0,
      requests: 0,
      mainRequests: 0,
      failedSql: 0,
      unattributedSql: 0,
      unattributedRequests: 0,
      malformedExecEvents: 0,
      sqlCountExact: true,
      bindingUpserts: 0,
      mainBindingUpserts: 0,
      requestsByOperation: {},
      sqlByOperation: {},
      bindingUpsertsByOperation: {},
    });
  const operation = (cause: unknown, stack: string[] = []): string => {
    if (!isRecord(cause)) {
      return "unattributed";
    }
    const discriminators: unknown[] = Array.isArray(cause.payloadDiscriminators)
      ? cause.payloadDiscriminators
      : [];
    const target = discriminators.find(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string" &&
        pair[1].startsWith("conversationBindings."),
    );
    if (Array.isArray(target) && typeof target[1] === "string") {
      return target[1];
    }
    // Frozen314 does not expose discriminators for state-broker execute payloads.
    // Native generic unbind/touch retain these named caller and worker frames.
    const frames = [...(isStringArray(cause.originStack) ? cause.originStack : []), ...stack];
    if (
      frames.some((frame) =>
        / at (?:async )?(?:touchCurrentConversationBindingInDatabase|touchGenericCurrentConversationBindingAsync) \(/u.test(
          frame,
        ),
      )
    ) {
      return "conversationBindings.touch";
    }
    if (
      frames.some(
        (frame) =>
          / at removeCurrentConversationBindingsInDatabase \(/u.test(frame) ||
          / at async Object\.unbind \(.*\/session-binding-service[^/]*\.mjs:/u.test(frame),
      )
    ) {
      return "conversationBindings.remove";
    }
    return "other";
  };
  const increment = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };
  const threads: Array<{ pid: number; threadId: number; isMainThread: boolean }> = [];
  for (const filename of filenames) {
    const sites = new Map<number, ObservedSite>();
    let main = false;
    for (const line of readFileSync(path.join(output, filename), "utf8").split("\n")) {
      if (!line) {
        continue;
      }
      const item: unknown = JSON.parse(line);
      if (isRecord(item) && item.type === "process") {
        assert.ok(
          typeof item.pid === "number" &&
            typeof item.threadId === "number" &&
            typeof item.isMainThread === "boolean",
        );
        main = gatewayPids.has(item.pid) && item.threadId === 0;
        threads.push({ pid: item.pid, threadId: item.threadId, isMainThread: item.isMainThread });
      } else if (isRecord(item) && item.type === "site") {
        assert.ok(
          typeof item.id === "number" &&
            typeof item.method === "string" &&
            typeof item.sql === "string" &&
            typeof item.ok === "boolean",
        );
        assert.ok(isStringArray(item.stack), "Frozen observer site has no code stack");
        sites.set(item.id, {
          method: item.method,
          sql: item.sql,
          ok: item.ok,
          cause: item.cause,
          stack: item.stack,
        });
      } else if (isRecord(item) && item.type === "request") {
        assert.ok(typeof item.phase === "string");
        const count = phaseCount(item.phase);
        count.requests++;
        if (main) {
          count.mainRequests++;
        }
        if (!hasCause(item.cause)) {
          count.unattributedRequests++;
        }
        increment(count.requestsByOperation, operation(item.cause));
      } else if (
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "number"
      ) {
        const site = sites.get(item[1]);
        assert.ok(site, "Frozen observer execution references an unknown site");
        if (site.method === "prepare") {
          continue;
        }
        const count = phaseCount(item[0]);
        if (!site.ok) {
          count.failedSql++;
          continue;
        }
        const split = site.method === "exec" ? execStatements.get(site.sql) : undefined;
        if (site.method === "exec") {
          assert.ok(split, "Frozen splitter did not return an exec shape");
          if (split.malformed) {
            count.malformedExecEvents++;
            count.sqlCountExact = false;
            continue;
          }
        }
        for (const sql of split?.pieces ?? [site.sql]) {
          count.sql++;
          if (main) {
            count.mainSql++;
          }
          if (!hasCause(site.cause)) {
            count.unattributedSql++;
          }
          increment(count.sqlByOperation, operation(site.cause, site.stack));
          if (/\binsert\s+into\s+"?current_conversation_bindings"?\b/iu.test(sql)) {
            count.bindingUpserts++;
            if (main) {
              count.mainBindingUpserts++;
            }
            increment(count.bindingUpsertsByOperation, operation(site.cause, site.stack));
          }
        }
      }
    }
  }
  return { counts, threads };
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    try {
      await stop();
    } finally {
      setPhase("done");
      const observerSummary = summarizeObserver();
      const profiles = values["cpu-profile"]
        ? ["seed", "measure"].flatMap((boot) => {
            const directory = path.join(output, "profiles", boot);
            return (existsSync(directory) ? readdirSync(directory) : [])
              .filter((name) => name.endsWith(".cpuprofile"))
              .map((name) => `${boot}/${name}`);
          })
        : [];
      const validationErrors: string[] = [];
      if (evidence.ok) {
        for (const action of evidence.actions) {
          const count = observerSummary.counts[action.phase];
          if ((count?.requestsByOperation["conversationBindings.remove"] ?? 0) === 0) {
            validationErrors.push(
              `${action.phase} never reached the target owner; no product verdict`,
            );
          }
          if (count?.sqlCountExact === false) {
            validationErrors.push(
              `${action.phase} contains malformed exec SQL; exact totals unavailable`,
            );
          }
          if (count?.failedSql) {
            validationErrors.push(`${action.phase} has failed SQL`);
          }
          if (
            values["expect-base"] &&
            (count?.bindingUpsertsByOperation["conversationBindings.remove"] ?? 0) === 0
          ) {
            validationErrors.push(`${action.phase} did not reproduce the base removal UPSERT`);
          }
          if (values["expect-candidate"]) {
            if ((count?.bindingUpsertsByOperation["conversationBindings.remove"] ?? 0) !== 0) {
              validationErrors.push(`${action.phase} still performs a stale-removal UPSERT`);
            }
            if (
              (count?.bindingUpsertsByOperation.unattributed ?? 0) +
                (count?.bindingUpsertsByOperation.other ?? 0) >
              0
            ) {
              validationErrors.push(
                `${action.phase} has unattributed binding UPSERTs; zero removal writes is unproven`,
              );
            }
          }
        }
        if (
          !evidence.shutdowns.every((item) => item.graceful && !item.forced && item.exitCode === 0)
        ) {
          validationErrors.push("Unclean shutdown invalidates cold restart/profile proof");
        }
        if (values["cpu-profile"]) {
          const measuredPid = evidence.launches.find((item) => item.boot === "measure")?.pid;
          for (const thread of observerSummary.threads.filter((item) => item.pid === measuredPid)) {
            if (
              !profiles.some(
                (name) =>
                  name.startsWith("measure/") &&
                  name.includes(`.${thread.pid}.${thread.threadId}.`),
              )
            ) {
              validationErrors.push(
                `Missing measurement CPU profile for thread ${thread.threadId}`,
              );
            }
          }
          if (!profiles.some((name) => name.startsWith("measure/"))) {
            validationErrors.push("No measurement CPU profiles were emitted");
          }
        }
      }
      if (validationErrors.length) {
        evidence.ok = false;
      }
      writeFileSync(
        path.join(output, "result.json"),
        `${JSON.stringify(
          {
            ...evidence,
            phases,
            expectBase: values["expect-base"],
            expectCandidate: values["expect-candidate"],
            validationErrors,
            publicationObservation: {
              observed: false,
              reason:
                "The frozen observer records SQL and worker requests, not binding fact publication. No zero-publication verdict is available from this run.",
            },
            countSemantics:
              "SQL counts reuse frozen causal.py statements() for exec, excluding prepare and failed calls. sqlCountExact=false means counts omit malformed exec events and are not exact totals. unattributedSql/Requests report missing causal coverage; owner-operation attribution may separately be unavailable. MAIN includes Gateway launch PIDs at thread 0 only, excluding helper-process mains.",
            latency: {
              cold:
                evidence.actions.find((item) => item.phase === "cold-mismatch")?.latencyMs ?? null,
              warm: summarizeNumbers(
                evidence.actions
                  .filter((item) => item.phase.startsWith("warm-mismatch-"))
                  .flatMap((item) => (item.latencyMs === undefined ? [] : [item.latencyMs])),
              ),
            },
            ...observerSummary,
            profiles,
          },
          null,
          2,
        )}\n`,
      );
      assert.equal(validationErrors.length, 0, validationErrors.join(";"));
    }
  })());
}
const onSigint = () => void cleanup().finally(() => process.exit(130));
const onSigterm = () => void cleanup().finally(() => process.exit(143));
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  await launch("seed");
  for (const [name, sessionKey] of [
    ["a", a],
    ["b", b],
  ] as const) {
    setPhase(`bind-${name}`);
    await send(
      sessionKey,
      `/acp spawn main --bind here --cwd ${workspace}`,
      "Spawned ACP session ",
    );
    evidence.nativeSpawns++;
  }
  setPhase("seed-proof");
  openProofDatabase();
  const heldA = row(a),
    heldB = row(b);
  assert.ok(heldA && heldB, "Native spawn did not create both generic bindings");
  assert.ok(
    heldA.binding_id !== heldB.binding_id && heldA.target_session_key !== heldB.target_session_key,
    "Synthetic conversations did not receive separate bindings",
  );
  const adapterEvents: unknown[] = readFileSync(path.join(controlDir, "adapter.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const creates = adapterEvents.filter(
    (event) => isRecord(event) && event.event === "session_create",
  );
  evidence.adapterCreates = creates.length;
  const adapterA = adapterSessionId(heldA.target_session_key);
  const adapterB = adapterSessionId(heldB.target_session_key);
  assert.notEqual(adapterA, adapterB, "Distinct binding targets share one backend ACP session");
  for (const [target, sessionId] of [
    ["a", adapterA],
    ["b", adapterB],
  ] as const) {
    const matchingCreates = creates.filter(
      (event) => isRecord(event) && event.sessionId === sessionId,
    ).length;
    evidence.adapterTargets.push({ target, matchingCreates });
    assert.equal(
      matchingCreates,
      1,
      "Binding target does not match exactly one adapter session creation",
    );
  }
  await stop();
  await launch("measure");
  evidence.restarted = true;
  setPhase("restart-proof");
  openProofDatabase();
  assert.ok(
    sameLogicalRow(heldA, row(a)) && sameLogicalRow(heldB, row(b)),
    "Restart changed seeded bindings",
  );
  for (let index = 0; index <= warmSamples; index++) {
    // Direct read-only proof stays outside Gateway counts and measured command latency.
    setPhase(index === 0 ? "cold-before-proof" : `warm-before-proof-${index}`);
    const beforeA = row(a);
    assert.ok(beforeA, "Protected sibling A disappeared before the mismatch");
    setPhase(index === 0 ? "cold-mismatch" : `warm-mismatch-${index}`);
    const action = await send(b, "/session unbind", "Conversation unbound.");
    const afterA = row(a),
      afterB = row(b);
    assert.ok(afterA, "Mismatch removed protected sibling A");
    assert.ok(sameLogicalRow(heldA, afterA), "Mismatch changed protected sibling A");
    assert.ok(sameLogicalRow(heldB, afterB), "Mismatch changed or removed binding B");
    evidence.preserved++;
    evidence.actions.push({
      phase: action.phase,
      ...(action.latencyMs === undefined ? {} : { latencyMs: action.latencyMs }),
      physicalTimestampChanged: beforeA.updated_at !== afterA.updated_at,
    });
  }
  setPhase("matched-control");
  await send(a, "/session unbind", "Conversation unbound.");
  assert.ok(row(a) === undefined, "Matching-ID unbind did not remove A");
  assert.ok(sameLogicalRow(heldB, row(b)), "Matching-ID unbind changed B");
  evidence.matchedRemove = true;
  evidence.ok = true;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
