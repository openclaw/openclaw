// Synthetic chat.history and sessions.diff traffic against an owned loopback Gateway.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayAllocations,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayCpuUsage,
  readGatewayGcTrace,
} from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    "tracked-files": { type: "string", default: "32" },
    "untracked-files": { type: "string", default: "32" },
    "unchanged-files": { type: "string", default: "0" },
    "managed-worktree": { type: "boolean", default: false },
    "dirty-baseline": { type: "boolean", default: false },
    mutate: { type: "boolean", default: false },
    "scoped-reader": { type: "boolean", default: false },
    port: { type: "string", default: "41072" },
    entry: { type: "string", default: "dist/entry.js" },
    clients: { type: "string", default: "4" },
    operations: { type: "string", default: "25" },
    rounds: { type: "string", default: "5" },
    "warmup-cohorts": { type: "string", default: "5" },
    scenario: { type: "string", default: "all" },
    allocations: { type: "boolean", default: false },
    "history-source": { type: "string" },
    "diff-source": { type: "string" },
    "start-at": { type: "string" },
    "start-file": { type: "string" },
    output: { type: "string" },
    revision: { type: "string" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["state-dir"]) {
  throw new Error("--state-dir must name an offline team-shape fixture");
}
const root = path.resolve(values["state-dir"]);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("Expected generated team-shape fixture; never use live state");
}
const fixtureNow = Number(fixture.now);
const port = integer(values.port, "--port", 40000);
if (port > 65535) {
  throw new Error("--port must be between 40000 and 65535");
}
const clientCount = integer(values.clients, "--clients");
const operations = integer(values.operations, "--operations");
const rounds = integer(values.rounds, "--rounds");
const warmupCohorts = integer(values["warmup-cohorts"], "--warmup-cohorts", 0);
let startAt = values["start-at"] ? integer(values["start-at"], "--start-at") : undefined;
const startFile = values["start-file"] ? path.resolve(values["start-file"]) : undefined;
if (startFile && startAt !== undefined) {
  throw new Error("--start-file and --start-at are mutually exclusive");
}
if (startFile && existsSync(startFile)) {
  throw new Error("--start-file must not already exist at setup");
}
const trackedFiles = integer(values["tracked-files"], "--tracked-files", 0);
const untrackedFiles = integer(values["untracked-files"], "--untracked-files", 0);
const unchangedFiles = integer(values["unchanged-files"], "--unchanged-files", 0);
const sessionId = "history-diff-measure";
const sessionKey = `agent:main:${sessionId}`;
const seedDir = path.join(root, "history-diff-fixture");
const seedPath = path.join(seedDir, "summary.json");
const profile = `team-shape-${port}`;
const env = createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-${profile}`,
    OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${profile}`,
    OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Gateway (${profile})`,
    OPENCLAW_SKIP_CHANNELS: "1",
    TMPDIR: path.join(root, "tmp"),
  },
});

async function seed() {
  if (values["dirty-baseline"] && trackedFiles === 0) {
    throw new Error("--dirty-baseline requires at least one tracked file");
  }
  // Exclusive creation makes an accidental second seed fail before changing any state.
  mkdirSync(seedDir);
  const previousEnv = process.env;
  process.env = { ...env };
  try {
    const repo = path.join(seedDir, "repository");
    const worktree = path.join(seedDir, "worktree");
    const branch = "fixture/history-diff";
    const lifecycleRevision = "history-diff-fixture-v1";
    mkdirSync(repo);
    const git = (...args: string[]) =>
      promisify(execFile)("git", ["-C", repo, ...args], {
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Synthetic Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Synthetic Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          GIT_AUTHOR_DATE: "2026-10-13T12:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-13T12:00:00Z",
        },
      });
    await git("init", "--initial-branch=main");
    for (let index = 0; index < trackedFiles; index++) {
      writeFileSync(path.join(repo, `tracked-${index}.txt`), `Synthetic tracked file ${index}\n`);
    }
    for (let index = 0; index < unchangedFiles; index++) {
      writeFileSync(
        path.join(repo, `unchanged-${index}.txt`),
        `Synthetic unchanged file ${index}\n`,
      );
    }
    await git("add", ".");
    await git(
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "test: seed synthetic diff",
    );
    await git("worktree", "add", "-b", branch, worktree);
    if (values["dirty-baseline"]) {
      for (let index = 0; index < trackedFiles; index++) {
        writeFileSync(
          path.join(worktree, `tracked-${index}.txt`),
          `Synthetic tracked file ${index}\nSynthetic pre-session edit\n`,
        );
      }
    }
    const [{ captureSessionDiffBaseline }, agentDb, stateDb, entries, transcripts, lifecycle] =
      await Promise.all([
        import("../../src/sessions/session-diff.js"),
        import("../../src/state/openclaw-agent-db.js"),
        import("../../src/state/openclaw-state-db.js"),
        import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
        import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
        import("../../src/shared/global-singleton.js"),
      ]);
    try {
      const baseline = await captureSessionDiffBaseline({ cwd: worktree, sessionId });
      const expectedBaselineFiles = values["dirty-baseline"] ? trackedFiles : 0;
      if (!baseline || baseline.truncated || baseline.files.length !== expectedBaselineFiles) {
        throw new Error("Synthetic session baseline does not match the requested tracked edits");
      }
      const managedBinding = values["managed-worktree"]
        ? { id: "history-diff-managed-worktree", branch, repoRoot: repo }
        : undefined;
      if (managedBinding) {
        const [registry, repositories, projections] = await Promise.all([
          import("../../src/agents/worktrees/registry-run-end.worker.js"),
          import("../../src/agents/worktrees/repository-paths.js"),
          import("../../src/gateway/worker-environments/local-workspace-store.kernel.js"),
        ]);
        const repository = await repositories.resolveRepositoryIdentity(repo);
        managedBinding.repoRoot = repository.repoRoot;
        const baseCommit = (await git("rev-parse", "HEAD")).stdout.trim();
        stateDb.runOpenClawStateWriteTransaction(
          ({ db }) => {
            registry.insertRegistryWorktreeInDatabase(db, {
              record: {
                ...managedBinding,
                name: managedBinding.id,
                repoFingerprint: repository.fingerprint,
                path: worktree,
                baseRef: "main",
                ownerKind: "session",
                ownerId: sessionKey,
                createdAt: fixtureNow,
                lastActiveAt: fixtureNow,
              },
              provisionedPaths: [],
            });
            projections.mutateLocalWorkspaceProjection(db, managedBinding.id, {
              kind: "create",
              row: {
                worktree_id: managedBinding.id,
                agent_id: "main",
                session_key: sessionKey,
                session_id: sessionId,
                lifecycle_revision: lifecycleRevision,
                projection_path: worktree,
                base_commit: baseCommit,
                source_paths_json: "[]",
                baseline_json: null,
                baseline_ref: null,
                checkpoint_json: null,
                pending_ref: null,
                pending_target: null,
                journal_json: null,
                journal_pack: null,
                paused_runtimes_json: null,
                created_at_ms: fixtureNow,
              },
            });
          },
          { env },
        );
      }
      const databaseOptions = { agentId: "main", env };
      agentDb.runOpenClawAgentWriteTransaction((database) => {
        if (entries.readExactSessionEntryRow(database, sessionKey)) {
          throw new Error("Synthetic history/diff session already exists");
        }
        entries.writeSessionEntry(database, sessionKey, {
          sessionId,
          createdAt: fixtureNow,
          updatedAt: fixtureNow,
          createdVia: "operator",
          lifecycleRevision,
          visibility: "shared",
          spawnedWorkspaceDir: repo,
          spawnedCwd: worktree,
          ...(managedBinding ? { worktree: managedBinding } : {}),
          sessionDiffBaseline: baseline,
        });
      }, databaseOptions);
      let parentId: string | null = null;
      let logicalBytes = 0;
      for (let turn = 0; turn < 64; turn++) {
        const bytes = [8192, 65536, 262144][turn % 3]!;
        let text = `Synthetic tool output ${turn}\n`;
        for (let index = 0; text.length < bytes; index++) {
          text += `${createHash("sha256").update(`${turn}:${index}`).digest("hex")}\n`;
        }
        text = text.slice(0, bytes);
        logicalBytes += text.length;
        const toolCallId = `fixture-tool-${turn}`;
        const messages = [
          { role: "user", content: [{ type: "text", text: `Inspect synthetic file ${turn}.` }] },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: toolCallId,
                name: "read",
                arguments: { path: `synthetic-${turn}.txt` },
              },
            ],
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId,
            toolName: "read",
            content: [{ type: "text", text }],
            isError: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: `Synthetic inspection ${turn} complete.` }],
            stopReason: "stop",
          },
        ];
        const events: TranscriptEvent[] = [];
        if (turn === 0) {
          events.push({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date(fixtureNow).toISOString(),
          });
        }
        for (const [index, message] of messages.entries()) {
          const id = `fixture-message-${turn}-${index}`;
          events.push({
            type: "message",
            id,
            parentId,
            timestamp: new Date(fixtureNow + turn).toISOString(),
            message: { ...message, timestamp: fixtureNow + turn },
          });
          parentId = id;
        }
        agentDb.runOpenClawAgentWriteTransaction((database) => {
          transcripts.appendTranscriptEventsInTransaction(
            database,
            { ...databaseOptions, sessionId, sessionKey },
            events,
          );
        }, databaseOptions);
      }
      for (let index = 0; index < trackedFiles; index++) {
        writeFileSync(
          path.join(worktree, `tracked-${index}.txt`),
          `Synthetic tracked file ${index}\n${"Synthetic added line\n".repeat(64)}`,
        );
      }
      for (let index = 0; index < untrackedFiles; index++) {
        writeFileSync(
          path.join(worktree, `untracked-${index}.txt`),
          `Synthetic untracked file ${index}\n${"Synthetic new line\n".repeat(64)}`,
        );
      }
      const database = agentDb.openOpenClawAgentDatabase(databaseOptions);
      const summary = {
        format: "openclaw-history-diff-v1",
        sessionKey,
        sessionId,
        logicalBytes,
        messages: 256,
        trackedFiles,
        untrackedFiles,
        unchangedFiles,
        managedWorktree: Boolean(managedBinding),
        baselineFiles: baseline.files.length,
        agentDatabaseBytes: statSync(database.path).size,
      };
      writeFileSync(seedPath, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(JSON.stringify(summary));
    } finally {
      await Promise.all([
        agentDb.closeOpenClawAgentDatabasesAsync(),
        stateDb.closeOpenClawStateDatabaseAsync(),
      ]);
      await lifecycle.drainGlobalSingletonLifecycleState();
    }
  } finally {
    process.env = previousEnv;
  }
}

const summarize = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: numbers.length,
    mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
};

async function measure() {
  const seeded: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
  if (!isRecord(seeded) || seeded.format !== "openclaw-history-diff-v1") {
    throw new Error("Run --seed once while the fixture is offline");
  }
  const seededCount = (field: "trackedFiles" | "untrackedFiles") => {
    const count = seeded[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid seeded ${field}`);
    }
    return count;
  };
  const expectedTrackedFiles = seededCount("trackedFiles");
  const expectedUntrackedFiles = seededCount("untrackedFiles");
  if (values.mutate && expectedTrackedFiles === 0) {
    throw new Error("--mutate requires a fixture with at least one changed tracked file");
  }
  const mutationPath = path.join(seedDir, "worktree", "tracked-0.txt");
  const mutationBytes = values.mutate ? readFileSync(mutationPath) : undefined;
  const output = path.resolve(
    values.output ?? path.join(root, `history-diff-measure-${Date.now()}`),
  );
  mkdirSync(output);
  const scopedReader = values["scoped-reader"];
  const historySource = values["history-source"];
  const diffSource = values["diff-source"] ? path.resolve(values["diff-source"]) : undefined;
  const diffSourceReceipt = path.join(output, "diff-source-loads.jsonl");
  const gitTracePath = path.join(output, "git-trace.jsonl");
  const readerIdentity = "history-diff-reader@example.invalid";
  const readerOrigin = "https://history-diff.example.invalid";
  let gatewayEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TRACE2_EVENT: gitTracePath,
    ...(historySource ? { OPENCLAW_BENCH_HISTORY_SOURCE: path.resolve(historySource) } : {}),
  };
  if (diffSource) {
    if (path.resolve(values.entry) !== path.resolve("src/entry.ts")) {
      throw new Error("--diff-source requires --entry src/entry.ts");
    }
    const preload = path.join(output, "diff-source-preload.cjs");
    const owner = new URL("../../src/sessions/session-diff.runtime.ts", import.meta.url).href;
    // NODE_OPTIONS also installs the hook in source Git workers with their own execArgv.
    writeFileSync(
      preload,
      `const { registerHooks } = require("node:module");
const { readFileSync, appendFileSync } = require("node:fs");
const { threadId } = require("node:worker_threads");
registerHooks({ load(url, context, nextLoad) {
  if (url !== ${JSON.stringify(owner)}) return nextLoad(url, context);
  const source = readFileSync(${JSON.stringify(diffSource)}, "utf8");
  appendFileSync(${JSON.stringify(diffSourceReceipt)}, JSON.stringify({ threadId }) + "\\n");
  return { format: "module-typescript", source, shortCircuit: true };
} });
`,
    );
    gatewayEnv.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  if (scopedReader) {
    const config: unknown = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
    if (!isRecord(config) || !isRecord(config.gateway)) {
      throw new Error("Expected generated Gateway configuration");
    }
    const scopes = ["operator.sessions.read"];
    config.gateway = {
      ...config.gateway,
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: [readerIdentity],
          allowLoopback: true,
        },
        identityScopes: { [readerIdentity]: scopes },
      },
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { enabled: false, allowedOrigins: [readerOrigin] },
      roles: {
        default: "reader",
        definitions: { reader: { sessions: { others: "view" }, agents: "*", scopes } },
      },
    };
    const configPath = path.join(output, "gateway-config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    gatewayEnv = { ...gatewayEnv, OPENCLAW_CONFIG_PATH: configPath };
  }
  const clients: ReturnType<typeof createGatewayWsClient>[] = [];
  const readerProfileIds = new Set<string>();
  let gateway: ChildProcess | undefined;
  const gcLogPath = path.join(output, "gateway-gc.log");
  let gcCapture: Promise<void> | undefined;
  let gcCaptureFailure: Error | undefined;
  let closing = false;
  let clientFailure: Error | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      closing = true;
      for (const client of clients) {
        client.close();
      }
      if (gateway) {
        await stopChild(gateway, { teardownGraceMs: 10_000, killGraceMs: 2000 });
      }
      await gcCapture;
      if (gcCaptureFailure) {
        throw gcCaptureFailure;
      }
    })());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
  const rpc = async (client: (typeof clients)[number], method: string, params: unknown) => {
    if (clientFailure) {
      throw clientFailure;
    }
    if (!gateway?.connected || gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Owned Gateway is no longer running");
    }
    const response = await client.request(method, params, 60_000);
    if (!response.ok) {
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    }
    return response.payload;
  };
  try {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
    const log = createWriteStream(path.join(output, "gateway.log"));
    const childArgs = buildGatewayBenchChildArgs(values.entry, port, [
      ...(values.allocations ? ["--trace-gc-nvp"] : []),
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
    ]);
    if (scopedReader) {
      childArgs[childArgs.indexOf("--auth") + 1] = "trusted-proxy";
    }
    gateway = spawn(process.execPath, childArgs, {
      env: gatewayEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    if (values.allocations && gateway.stdout) {
      // Keep V8 lines and synchronous capture markers together, without stderr interleaving.
      gcCapture = pipeline(gateway.stdout, createWriteStream(gcLogPath)).catch((error: unknown) => {
        gcCaptureFailure = error instanceof Error ? error : new Error(String(error));
      });
    }
    let startup = "";
    let listening = false;
    const observe = (chunk: Buffer) => {
      startup = (startup + chunk.toString()).slice(-4096);
      listening ||= startup.includes("http server listening (");
    };
    gateway.stdout?.on("data", observe);
    gateway.stderr?.on("data", observe);
    const deadline = Date.now() + 180_000;
    while (true) {
      if (gateway.exitCode !== null || gateway.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Gateway failed to become ready; inspect ${output}`);
      }
      if (
        listening &&
        (await fetch(`http://127.0.0.1:${port}/readyz`).then(
          (response) => response.ok,
          () => false,
        ))
      ) {
        break;
      }
      await delay(250);
    }
    await readGatewayCpuUsage(gateway);
    await delay(10_000);
    for (let index = 0; index < clientCount; index++) {
      const client = createGatewayWsClient({
        url: `ws://127.0.0.1:${port}`,
        ...(scopedReader
          ? {
              origin: readerOrigin,
              headers: {
                "x-forwarded-for": "203.0.113.50",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "history-diff.example.invalid",
                "x-forwarded-user": readerIdentity,
              },
            }
          : {}),
      });
      clients.push(client);
      client.ws.on("error", (error) => {
        clientFailure ??= error;
      });
      client.ws.on("close", (code) => {
        if (!closing) {
          clientFailure ??= new Error(`Client ${index} closed (${code})`);
        }
      });
      await client.waitOpen();
      const hello = await rpc(client, "connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: scopedReader ? "openclaw-control-ui" : "gateway-client",
          displayName: "synthetic-history-diff-measurement",
          version: "1.0.0",
          platform: process.platform,
          mode: scopedReader ? "ui" : "backend",
        },
        role: "operator",
        scopes: scopedReader ? ["operator.sessions.read"] : ["operator.read", "operator.admin"],
        caps: [],
      });
      if (scopedReader) {
        if (
          !isRecord(hello) ||
          !isRecord(hello.auth) ||
          hello.auth.method !== "trusted-proxy" ||
          !Array.isArray(hello.auth.scopes) ||
          hello.auth.scopes.length !== 1 ||
          hello.auth.scopes[0] !== "operator.sessions.read"
        ) {
          throw new Error("Synthetic reader did not acquire exactly operator.sessions.read");
        }
        const self = await rpc(client, "users.self", {});
        if (
          !isRecord(self) ||
          !isRecord(self.profile) ||
          typeof self.profile.id !== "string" ||
          !self.profile.id ||
          self.profile.id === GATEWAY_OWNER_PROFILE_ID
        ) {
          throw new Error("Synthetic reader did not acquire an individual user profile");
        }
        readerProfileIds.add(self.profile.id);
      }
    }
    const allVariants = [
      {
        name: "history-small",
        method: "chat.history",
        params: { limit: 20, maxBytes: 32 * 1024, toolResultMaxChars: 8192 },
      },
      { name: "history-default", method: "chat.history", params: {} },
      {
        name: "history-large",
        method: "chat.history",
        params: { limit: 256, maxBytes: 2 * 1024 * 1024, toolResultMaxChars: 500_000 },
      },
      ...(["all", "uncommitted"] as const).map((scope) => ({
        name: `diff-${scope}-full`,
        method: "sessions.diff",
        params: { scope, summaryOnly: false },
      })),
    ];
    const variants =
      values.scenario === "all"
        ? allVariants
        : allVariants.filter((variant) => variant.name === values.scenario);
    if (variants.length === 0) {
      throw new Error(
        `--scenario must be all or one of: ${allVariants.map((variant) => variant.name).join(", ")}`,
      );
    }
    const diffHashes = new Map<string, string>();
    const mutate = (variant: (typeof variants)[number]) => {
      if (mutationBytes && variant.method === "sessions.diff") {
        // Advance filesystem freshness without changing the response oracle.
        writeFileSync(mutationPath, mutationBytes);
      }
    };
    const request = async (
      client: (typeof clients)[number],
      variant: (typeof variants)[number],
    ) => {
      const started = performance.now();
      const response = await rpc(client, variant.method, { sessionKey, ...variant.params });
      const elapsedMs = performance.now() - started;
      if (!isRecord(response)) {
        throw new Error(`${variant.name}: missing response`);
      }
      const rows = variant.method === "chat.history" ? response.messages : response.files;
      if (!Array.isArray(rows) || response.unavailableReason) {
        throw new Error(`${variant.name}: empty or unavailable result`);
      }
      if (variant.method === "chat.history") {
        if (rows.length === 0 || response.sessionId !== sessionId) {
          throw new Error(`${variant.name}: wrong session`);
        }
      } else {
        if (
          rows.length !== expectedTrackedFiles + expectedUntrackedFiles ||
          rows.filter((file) => isRecord(file) && file.untracked === true).length !==
            expectedUntrackedFiles ||
          rows.filter((file) => isRecord(file) && file.status === "modified").length !==
            expectedTrackedFiles
        ) {
          throw new Error(`${variant.name}: missing tracked/untracked changes`);
        }
        if (
          variant.name.endsWith("-full") &&
          rows.length > 0 &&
          !rows.some(
            (file) => isRecord(file) && typeof file.patch === "string" && file.patch.length > 0,
          )
        ) {
          throw new Error(`${variant.name}: missing patches`);
        }
      }
      const comparable =
        variant.method === "chat.history"
          ? {
              ...response,
              ...(isRecord(response.sessionInfo)
                ? { sessionInfo: { ...response.sessionInfo, snapshotAt: 0 } }
                : {}),
            }
          : Object.fromEntries(
              Object.entries(response).filter(([key]) => key !== "root" && key !== "sessionKey"),
            );
      const payloadJson = JSON.stringify(comparable, (_key, value: unknown) =>
        variant.method === "chat.history" && typeof value === "string"
          ? value.replaceAll(root, "<fixture>")
          : value,
      );
      const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
      if (!diffHashes.has(variant.name)) {
        writeFileSync(path.join(output, `${variant.name}.json`), payloadJson);
      }
      if (variant.method === "sessions.diff") {
        const previous = diffHashes.get(variant.name);
        if (previous && previous !== payloadSha256) {
          throw new Error(`${variant.name}: unchanged checkout returned different payload bytes`);
        }
      }
      diffHashes.set(variant.name, payloadSha256);
      return {
        elapsedMs,
        payloadBytes: Buffer.byteLength(JSON.stringify(response)),
        payloadSha256,
        rows: rows.length,
      };
    };
    // Separate cold first use from the concurrent warmup that starts burst readers.
    const warmup = [];
    for (const variant of variants) {
      warmup.push({ variant: variant.name, sample: await request(clients[0]!, variant) });
    }
    if (
      variants.some((variant) => variant.method === "sessions.diff") &&
      !existsSync(gitTracePath)
    ) {
      throw new Error("Synthetic diff warmup did not produce a Git trace");
    }
    if (diffSource && !existsSync(diffSourceReceipt)) {
      throw new Error("Selected diff source was not loaded during warmup");
    }
    console.log(JSON.stringify({ ready: true, output }));
    if (startAt !== undefined) {
      if (Date.now() >= startAt) {
        throw new Error("--start-at passed before fixture readiness");
      }
      // Run the final cohorts near the barrier, before idle retirement of burst readers.
      await delay(Math.max(0, startAt - Date.now() - 10_000));
    }
    for (let cohort = 0; cohort < warmupCohorts; cohort++) {
      for (const variant of variants) {
        mutate(variant);
        await Promise.all(clients.map((client) => request(client, variant)));
      }
    }
    console.log(JSON.stringify({ warmed: true, output }));
    const results = [];
    const waitForStart = async () => {
      if (results.length !== 0) {
        return;
      }
      if (startFile) {
        while (!existsSync(startFile)) {
          await delay(100);
        }
        startAt = integer(readFileSync(startFile, "utf8").trim(), "--start-file deadline");
      }
      if (startAt !== undefined) {
        if (Date.now() >= startAt) {
          throw new Error("Start deadline passed before measurement readiness");
        }
        await delay(startAt - Date.now());
      }
    };
    for (let round = 0; round < rounds; round++) {
      for (const variant of variants) {
        const profilePath = path.join(
          output,
          `${variant.name}-${round}.${values.allocations ? "heapprofile" : "cpuprofile"}`,
        );
        let startedAt = 0;
        let traceStart = 0;
        let traceEnd = 0;
        const samples: Awaited<ReturnType<typeof request>>[] = [];
        const workload = async () => {
          traceStart = existsSync(gitTracePath) ? statSync(gitTracePath).size : 0;
          startedAt = Date.now();
          for (let operation = 0; operation < operations; operation++) {
            mutate(variant);
            samples.push(...(await Promise.all(clients.map((client) => request(client, variant)))));
          }
          traceEnd = existsSync(gitTracePath) ? statSync(gitTracePath).size : 0;
        };
        let cpu;
        let profileResult;
        await waitForStart();
        if (values.allocations) {
          profileResult = await measureGatewayAllocations(
            gateway,
            profilePath,
            clientCount * operations,
            workload,
          );
          cpu = profileResult.cpu;
        } else {
          await controlGatewayProfile(gateway, "cpu", "start", profilePath);
          const before = await readGatewayCpuUsage(gateway);
          await workload();
          cpu = measureGatewayCpuUsage(before, await readGatewayCpuUsage(gateway));
          await controlGatewayProfile(gateway, "cpu", "stop", profilePath);
          profileResult = readGatewayCpuProfile(profilePath);
        }
        if (
          !profileResult.diagnostics ||
          profileResult.diagnostics.collectionErrors ||
          profileResult.diagnostics.droppedEvents ||
          profileResult.diagnostics.droppedHistogramSamples
        ) {
          throw new Error(`${variant.name}: incomplete diagnostic capture`);
        }
        const gitSpawns =
          traceEnd > traceStart
            ? readFileSync(gitTracePath)
                .subarray(traceStart, traceEnd)
                .toString("utf8")
                .split("\n")
                .filter(Boolean)
                .filter((line) => {
                  const event: unknown = JSON.parse(line);
                  return isRecord(event) && event.event === "start";
                }).length
            : 0;
        const result = {
          round,
          variant: variant.name,
          startedAt,
          request: variant.params,
          latencyMs: summarize(samples.map((sample) => sample.elapsedMs)),
          payloadBytes: summarize(samples.map((sample) => sample.payloadBytes)),
          payloadSha256: [...new Set(samples.map((sample) => sample.payloadSha256))],
          samples,
          gitSpawns,
          gitSpawnsPerRpc: gitSpawns / samples.length,
          cpu,
          profile: profileResult,
        };
        results.push(result);
        console.log(
          JSON.stringify({
            round,
            variant: variant.name,
            latencyMs: result.latencyMs,
            mainThreadCpuMs: cpu.mainThread.totalMs,
            processCpuMs: cpu.process.totalMs,
          }),
        );
      }
    }
    // Promotion parsing needs complete stdout, including the final capture's stop marker.
    if (values.allocations) {
      await cleanup();
    }
    const diffSourceLoads: unknown[] = diffSource
      ? (existsSync(diffSourceReceipt) ? readFileSync(diffSourceReceipt, "utf8") : "")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    if (
      diffSource &&
      !diffSourceLoads.some((load) => isRecord(load) && Number(load.threadId) > 0)
    ) {
      throw new Error("Selected diff source was not loaded by a Git worker");
    }
    const report = {
      revision: values.revision ?? null,
      historySources: historySource
        ? Object.fromEntries(
            ["chat-history-session-read.ts", "chat-history-handler.ts"].map((file) => [
              file,
              createHash("sha256")
                .update(readFileSync(path.join(historySource, file)))
                .digest("hex"),
            ]),
          )
        : undefined,
      entry: values.entry,
      diffSource: diffSource
        ? {
            sha256: createHash("sha256").update(readFileSync(diffSource)).digest("hex"),
            loads: diffSourceLoads,
          }
        : undefined,
      mutate: values.mutate,
      scenario: values.scenario,
      profiling: values.allocations ? "allocations" : "cpu",
      reader: scopedReader ? "scoped-profile" : "admin",
      readerProfileIds: [...readerProfileIds],
      fixture,
      seeded,
      clientCount,
      operationsPerClientPerRound: operations,
      rounds,
      warmupCohorts,
      requestedStartAt: startAt ?? null,
      startFile: startFile ?? null,
      startSkewMs: startAt === undefined ? null : results[0]!.startedAt - startAt,
      warmup,
      results: results.map((result) => {
        if (!values.allocations) {
          return result;
        }
        const promotion = readGatewayGcTrace(gcLogPath, result.profile.profilePath);
        return Object.assign(result, {
          promotion: {
            ...promotion,
            promotedBytesPerOperation: promotion.promotedBytes / (clientCount * operations),
          },
        });
      }),
    };
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`RESULT ${path.join(output, "result.json")}`);
  } finally {
    await cleanup();
  }
}

if (values.seed) {
  await seed();
} else {
  await measure();
}
