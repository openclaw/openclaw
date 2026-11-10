// Real isolated Gateway subscriptions; fixture preparation stays outside measurement scopes.
// Mixed workload: --mutation label --list-every 8 --turn-every 10 --mock-port 41568.
// Prepare the fixture's OpenAI model with applyMockOpenAiModelConfig for that port,
// a synthetic API key, and the openai plugin enabled. The mock never contacts a provider.
// --count-checks injects bounded owner/invalidation counters: separate count passes from timing.
// --cpu-profile adds sampled owner timings in a separate pass without injected counters.
// Counter suffixes classify event scopes/facts, never session IDs, paths, or arbitrary stacks.
// Timing/GC runs omit --trace-gc; collect promotion in separate matched traced passes.
// --startup-timeout-ms extends setup readiness only; fixed warmup and timed work stay unchanged.
// --mixed-invalidation adds concurrent streamed turns, one native child spawn, and one PR receipt.
// Its fixture needs tools.toolSearch=false and tools.codeMode.enabled=false for native tools.
// Suggested: --clients 4 --keys 18 --operations 30 --interval-ms 2000 --turn-every 10.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, TextDecoder } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayAllocations,
  readGatewayCpuProfile,
  readGatewayGcTrace,
} from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv, waitForInitialProbe } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    child: { type: "boolean" },
    "owner-suffix": { type: "string" },
    revision: { type: "string" },
    "trace-gc": { type: "boolean", default: false },
    "count-checks": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "mixed-invalidation": { type: "boolean", default: false },
    "warmup-ms": { type: "string", default: "0" },
    "startup-timeout-ms": { type: "string", default: "180000" },
    port: { type: "string", default: "41567" },
    clients: { type: "string", default: "8" },
    keys: { type: "string", default: "50" },
    operations: { type: "string", default: "1000" },
    subscribes: { type: "string", default: "256" },
    mutation: { type: "string", default: "category" },
    "interval-ms": { type: "string", default: "20" },
    "list-every": { type: "string", default: "0" },
    "turn-every": { type: "string", default: "0" },
    "mock-port": { type: "string" },
    "start-at": { type: "string" },
  },
});
const integer = (value: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw: value, label, fallback: min, min });
const port = integer(values.port, "--port", 40000);
const startupTimeout = integer(values["startup-timeout-ms"], "--startup-timeout-ms");
assert(port <= 65535);
const channel = "session-pr-subscriptions-bench";
const benchmarkOwners = [
  "control-ui-session-task-prs",
  "control-ui-session-pr-read",
  "control-ui-session-pr-subscriptions",
  "control-ui-session-pr-prepared-read",
  "session-row-scope",
  "session-row-projection",
  "session-row-projection-materialize",
  "session-row-projection-revisions",
];
type BenchReply = {
  notifications: number;
  scopeCount: number;
  drainMs: number;
  pendingScopes: number;
  checks?: Record<string, number>;
  mixed?: Record<string, unknown>;
};

if (values.child) {
  const ownerLoads = new Set<string>();
  let active = false;
  const checks: Record<string, number> = {};
  const installedChecks = new Set<string>();
  let readSharingChange:
    | typeof import("../../src/config/sessions/session-accessor.sqlite-entry-cache-publication.js").readPreparedSessionSharingChange
    | undefined;
  // These fixed buckets bound cardinality even when a plugin supplies another scope.
  const changeScopes = new Set([
    "automation",
    "runtime",
    "session-entry",
    "acp",
    "transcript",
    "profiles",
    "catalog",
    "agent-runs",
    "subagent-runs",
    "worker-placements",
    "worker-environments",
    "config",
    "config-presentation",
    "config-profiles",
    "stores",
  ]);
  const factKinds = new Set([
    "unchanged",
    "replacement",
    "entry",
    "member",
    "owner",
    "participants",
    "category",
    "removed",
    "acp",
  ]);
  const changeReason = (change: unknown) => {
    if (!isRecord(change)) {
      return "none";
    }
    if (["pending", "committed", "settled", "unknown"].includes(String(change.kind))) {
      return `receipt.${String(change.kind)}`;
    }
    const scope =
      typeof change.scope === "string" && changeScopes.has(change.scope)
        ? change.scope
        : isRecord(change.scope)
          ? "scoped"
          : "other";
    const fact =
      isRecord(change.facts) &&
      typeof change.facts.kind === "string" &&
      factKinds.has(change.facts.kind)
        ? change.facts.kind
        : "none";
    return `${"all" in change ? "all" : "key"}.${scope}.${fact}.${change.factsInvalidated ? "invalidated" : "published"}.${readSharingChange?.(change) ?? "unknown"}`;
  };
  type CheckHook = readonly [owner: string, name: string, pattern: RegExp, injection?: string];
  const checkHooks: readonly CheckHook[] = [
    [
      "control-ui-session-task-prs",
      "readPublicationRow",
      /function readPublicationRow\([^]*?\)\s*\{/,
    ],
    [
      "control-ui-session-task-prs",
      "taskAssertCurrent",
      /assertCurrent:\s*(?:__name\(\s*)?\(\)\s*=>\s*\{/,
    ],
    [
      "session-row-projection-materialize",
      "lookupSessionRow",
      /const\s*\{\s*agentId\s*\}\s*=\s*query;/,
    ],
    [
      "control-ui-session-pr-read",
      "captureCurrent",
      /const captureCurrent\s*=\s*(?:__name\(\s*)?\(\)\s*=>\s*\{/,
    ],
    [
      "control-ui-session-pr-read",
      "assertCurrent",
      /assertCurrent:\s*(?:__name\(\s*)?\(\)\s*=>\s*\{(?=\s*const\s+current\s*=\s*captureCurrent\(\);)/,
    ],
    [
      "control-ui-session-pr-subscriptions",
      "currentWatcher",
      /const currentWatcher\s*=\s*(?:__name\(\s*)?(?:async\s*)?\([^]*?\)\s*=>\s*\{/,
    ],
    [
      "control-ui-session-pr-subscriptions",
      "currentKeyState",
      /const currentKeyState\s*=\s*(?:__name\(\s*)?async\s*(?:\([^]*?\)|cacheKey)\s*=>\s*\{/,
    ],
    [
      "control-ui-session-task-prs",
      "publicationRowCapture",
      /row\s*=\s*projection.capture\(node.query\);?/,
    ],
    [
      "session-row-projection",
      "sharing.catalog",
      /revisions.invalidate\(\);?(?=\s*revisions.publishFacts\(\);)/,
    ],
    ["session-row-projection", "sharing.removal", /revisions.invalidate\(true\);?/],
    [
      "session-row-projection",
      "sharing.runtimeMark",
      /revisions.invalidate\(!catalogOnly\);?/,
      'globalThis.__sessionPrCurrencyProbe("sharing.runtimeMark", change);',
    ],
    [
      "session-row-projection",
      "sharing.transcriptRefresh",
      /revisions.invalidate\(\);?(?=\s*records.invalidateDatabaseFacts)/,
    ],
    [
      "session-row-projection-revisions",
      "sharing.attempt",
      /sharing\s*=\s*(?:undefined|void 0);?/,
      'globalThis.__sessionPrCurrencyProbe("sharing.attempt"); if (sharing) globalThis.__sessionPrCurrencyProbe("sharing.retired");',
    ],
    ["session-row-projection-revisions", "sharing.materialized", /invalidate\(boardChanged\);?/],
    ["session-row-projection-revisions", "sharing.replace", /invalidate\(changed\);?/],
    ["session-row-projection-revisions", "sharing.selection", /invalidate\(true\);?/],
    [
      "session-row-projection-revisions",
      "taskRevision.selection",
      /if\s*\(!row\s*\|\|\s*removed\)\s*\{\s*taskPublication\s*=\s*(?:undefined|void 0);?/,
    ],
    [
      "session-row-projection-revisions",
      "taskRevision.runtimeMark",
      /if\s*\(change.factsInvalidated[^]*?taskPublication\s*=\s*(?:undefined|void 0);?/,
      'globalThis.__sessionPrCurrencyProbe("taskRevision.runtimeMark", change);',
    ],
    [
      "session-row-projection-revisions",
      "taskRevision.replace",
      /!isDeepStrictEqual\(previous.parents,\s*row.parents\)\s*\)\s*\{\s*taskPublication\s*=\s*(?:undefined|void 0);?/,
    ],
    [
      "control-ui-session-pr-subscriptions",
      "lineage.received",
      /const stopLineage\s*=\s*sessionChanges.subscribeFacts\(\(?change\)?\s*=>\s*\{/,
      'globalThis.__sessionPrCurrencyProbe("lineage.received", change);',
    ],
    [
      "control-ui-session-pr-subscriptions",
      "lineage.scheduledKeys",
      /if\s*\(keys(?:\?\.length|\.length\s*>\s*0)\)\s*\{/,
      'globalThis.__sessionPrCurrencyProbe("lineage.scheduledKeys", change, keys.length);',
    ],
    [
      "control-ui-session-pr-subscriptions",
      "currentKeyState.lineage",
      /return Promise.allSettled\(keys.map\(currentKeyState\)\);?/,
      'globalThis.__sessionPrCurrencyProbe("currentKeyState.lineage", change, keys.length);',
    ],
    [
      "control-ui-session-pr-subscriptions",
      "receipt.received",
      /const stopReceipts\s*=\s*githubPublicationReceipts.subscribeFacts\(\(?change\)?\s*=>\s*\{/,
      'globalThis.__sessionPrCurrencyProbe("receipt.received", change);',
    ],
    [
      "control-ui-session-pr-subscriptions",
      "receipt.refreshedKeys",
      /state.snapshot\s*=\s*(?:undefined|void 0);?(?=\s*if\s*\(state.prepared\))/,
      'globalThis.__sessionPrCurrencyProbe("receipt.refreshedKeys", change);',
    ],
  ];
  if (values["count-checks"]) {
    Object.assign(globalThis, {
      __sessionPrCurrencyProbe: (name: string, change?: unknown, count = 1) => {
        if (active) {
          const key = change === undefined ? name : `${name}.${changeReason(change)}`;
          checks[key] = (checks[key] ?? 0) + count;
        }
      },
    });
    registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        const matching = checkHooks.filter(([owner]) => {
          const suffix = values["owner-suffix"] ? `.${values["owner-suffix"]}` : "";
          return url === new URL(`../../src/gateway/${owner}${suffix}.ts`, import.meta.url).href;
        });
        if (matching.length === 0) {
          return loaded;
        }
        assert(loaded.source, `Missing source for ${url}`);
        let source =
          typeof loaded.source === "string"
            ? loaded.source
            : new TextDecoder().decode(loaded.source);
        for (const [, name, pattern, injection] of matching) {
          const start =
            name === "lookupSessionRow" ? source.indexOf("function lookupSessionRow(") : 0;
          assert(start >= 0, `Missing currency owner: ${name}`);
          const body = source.slice(start);
          assert.equal(
            [...body.matchAll(new RegExp(pattern, "g"))].length,
            1,
            `Currency hook must match once: ${name}`,
          );
          source =
            source.slice(0, start) +
            body.replace(pattern, (match) => {
              const probe =
                injection ?? `globalThis.__sessionPrCurrencyProbe(${JSON.stringify(name)});`;
              // The lineage return must count before returning; other probes follow their effect.
              return name === "currentKeyState.lineage" || name === "sharing.attempt"
                ? `${probe} ${match}`
                : `${match}; ${probe}`;
            });
          checks[name] = 0;
          installedChecks.add(name);
        }
        return { ...loaded, source };
      },
    });
  }
  if (values["owner-suffix"]) {
    assert(/^[a-z0-9-]+$/.test(values["owner-suffix"]));
    const owners = new Set(
      benchmarkOwners.map((name) => new URL(`../../src/gateway/${name}.ts`, import.meta.url).href),
    );
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (!owners.has(resolved.url)) {
          return resolved;
        }
        ownerLoads.add(resolved.url);
        return { ...resolved, url: resolved.url.replace(/\.ts$/, `.${values["owner-suffix"]}.ts`) };
      },
    });
  }
  if (values["count-checks"]) {
    ({ readPreparedSessionSharingChange: readSharingChange } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-cache-publication.js"));
  }
  await import("../lib/gateway-bench-profile-preload.ts");
  const { sessionChanges, sessionChangeScopeAffectsStoredRows } =
    await import("../../src/sessions/session-row-changes.ts");
  const { AsyncWorkScope } = await import("../../src/shared/async-work-scope.ts");
  const scopes = new Set<InstanceType<typeof AsyncWorkScope>>();
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver; arm restores the method.
  const nativeTrack = AsyncWorkScope.prototype.track;
  // Capture the subscription owner during setup, excluding ingress/connection lifetime scopes.
  AsyncWorkScope.prototype.track = new Proxy(nativeTrack, {
    apply(target, scope: InstanceType<typeof AsyncWorkScope>, args) {
      const caller = new Error().stack?.split("\n")[2] ?? "";
      if (/\/control-ui-session-pr-subscriptions(?:\.[a-z0-9-]+)?\.ts:\d+:\d+\)?$/.test(caller)) {
        scopes.add(scope);
      }
      return Reflect.apply(target, scope, args);
    },
  });
  // Restored fixtures have new file identities; use the CLI's credential admission owner.
  const { prepareStartupClientCredentials } =
    await import("../../src/commands/startup-client-credentials.ts");
  await prepareStartupClientCredentials({ env: process.env });
  const { startGatewayServer } = await import("../../src/gateway/server.ts");
  let notifications = 0;
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      active &&
      sessionChangeScopeAffectsStoredRows(change) &&
      !("facts" in change && change.facts?.kind === "unchanged")
    ) {
      notifications++;
    }
  });
  process.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== channel) {
      return;
    }
    void (async () => {
      let drainMs = 0;
      let mixed: Record<string, unknown> | undefined;
      if (message.action === "publish") {
        assert(values["mixed-invalidation"] && typeof message.sessionKey === "string");
        assert(
          typeof message.receiptNumber === "number" && Number.isSafeInteger(message.receiptNumber),
        );
        const { getRuntimeConfig } = await import("../../src/config/config.ts");
        const { readResolvedSessionEntryInWorker } =
          await import("../../src/config/sessions/session-accessor.entry.ts");
        const entry = await readResolvedSessionEntryInWorker({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey: message.sessionKey,
        });
        assert(entry?.sessionId);
        const { insertRepositoryGitHubPublicationFixture } =
          await import("../../src/gateway/github-publication-store.test-support.ts");
        const { repositoryGitHubPublicationDigest } =
          await import("../../src/gateway/github-repository-publication.kernel.ts");
        const requestId = `session-pr-benchmark-${process.pid}`;
        const row: import("../../src/state/github-publication-read.types.ts").RepositoryGitHubPublicationRow =
          {
            request_id: requestId,
            idempotency_key: requestId,
            request_digest: "",
            session_id: entry.sessionId,
            session_key: message.sessionKey,
            agent_id: "main",
            session_lifecycle_revision: entry.lifecycleRevision ?? null,
            requester_authority_json: null,
            workspace_id: requestId,
            owner_profile_id: null,
            connection_generation: null,
            identity_source: "system-configured",
            identity_profile_id: "synthetic-profile",
            identity_account_id: 42,
            identity_login: "fixture-bot",
            title: "Synthetic subscription publication",
            body: null,
            draft: null,
            status: "published",
            gateway_instance_id: null,
            execution_id: null,
            push_repository: "synthetic/subscriptions",
            repository: "synthetic/subscriptions",
            branch: "synthetic-subscription",
            base_branch: "main",
            source_head_commit: "b".repeat(40),
            source_index_tree: "c".repeat(40),
            workspace_tree: "c".repeat(40),
            previous_head_commit: null,
            pushed_head_commit: null,
            head_commit: null,
            pull_request_url: `https://github.com/synthetic/subscriptions/pull/${message.receiptNumber}`,
            claim_id: null,
            run_id: null,
            environment_id: null,
            owner_epoch: null,
            placement_generation: null,
            checkpoint_ref: null,
            checkpoint_digest: null,
            error_code: null,
            next_action: null,
            last_effect: null,
            effect_state: null,
            created_at_ms: Date.now(),
            updated_at_ms: Date.now(),
            reported_at_ms: null,
          };
        row.request_digest = repositoryGitHubPublicationDigest(row);
        insertRepositoryGitHubPublicationFixture(row, () => {});
        mixed = { publishedUrl: row.pull_request_url };
      }
      if (message.action === "inspect-child") {
        assert(values["mixed-invalidation"] && typeof message.label === "string");
        const { subagentRuns } =
          await import("../../src/agents/subagents/registry/subagent-registry-memory.ts");
        const children = [...subagentRuns.values()].filter((row) => row.label === message.label);
        assert.equal(children.length, 1, "Exactly one native benchmark child must be recorded");
        const row = children[0]!;
        mixed = {
          childSessionKey: row.childSessionKey,
          requesterSessionKey: row.requesterSessionKey,
          runId: row.runId,
        };
      }
      if (message.action === "capture") {
        scopes.clear();
      }
      if (message.action === "arm") {
        if (values["count-checks"]) {
          assert.equal(installedChecks.size, checkHooks.length, "All currency hooks must load");
        }
        AsyncWorkScope.prototype.track = nativeTrack;
        assert.equal(
          scopes.size,
          1,
          "Subscription setup must capture exactly its native work owner",
        );
      }
      if (message.action === "arm" || message.action === "settle") {
        const started = performance.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            AsyncWorkScope.runWhenAllIdle(
              () => [...scopes],
              () => undefined,
            ),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Native subscription scope did not settle within 30s (${scopes.size} captured, ${[...scopes].filter((scope) => scope.hasPendingWork).length} pending)`,
                    ),
                  ),
                30000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        drainMs = performance.now() - started;
      }
      if (message.action === "start") {
        active = true;
        notifications = 0;
        for (const name of Object.keys(checks)) {
          checks[name] = 0;
        }
      } else if (message.action === "stop") {
        active = false;
      }
      process.send?.({
        channel,
        action: message.action,
        notifications,
        ...(mixed ? { mixed } : {}),
        ...(values["count-checks"] ? { checks } : {}),
        scopeCount: scopes.size,
        pendingScopes: [...scopes].filter((scope) => scope.hasPendingWork).length,
        drainMs,
      });
    })().catch((error: unknown) => {
      process.send?.({ channel, action: message.action, error: String(error) });
    });
  });
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  if (values["owner-suffix"]) {
    assert.equal(ownerLoads.size, benchmarkOwners.length, "All candidate owners must be loaded");
  }
  process.send?.({ channel, action: "ready" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stop();
      void server
        .close({ reason: "Synthetic subscription benchmark complete" })
        .then(() => process.exit(0));
    });
  }
} else {
  assert(values.root && values.output, "--root and --output are required");
  const root = path.resolve(values.root);
  const output = path.resolve(values.output);
  mkdirSync(output, { recursive: true });
  const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
  assert.equal(fixture.format, "openclaw-team-shape-v1");
  assert.equal(fixture.sessionCount, 5000);
  const clients = integer(values.clients, "--clients");
  const keyCount = integer(values.keys, "--keys");
  const operations = integer(values.operations, "--operations");
  const subscribes = integer(values.subscribes, "--subscribes");
  const mutation = values.mutation;
  assert(mutation === "category" || mutation === "label", "--mutation must be category or label");
  const interval = integer(values["interval-ms"], "--interval-ms");
  const listEvery = integer(values["list-every"], "--list-every", 0);
  const turnEvery = integer(values["turn-every"], "--turn-every", 0);
  const mixed = values["mixed-invalidation"];
  assert(
    !values["cpu-profile"] || !values["count-checks"],
    "CPU profiles require a separate pass without injected counters",
  );
  assert(
    !mixed || (clients >= 3 && keyCount >= 3 && operations >= 3 && turnEvery > 0),
    "Mixed invalidation needs >=3 clients/keys/operations and --turn-every",
  );
  const mockPort = values["mock-port"]
    ? integer(values["mock-port"], "--mock-port", 40000)
    : undefined;
  assert(
    !turnEvery || (mockPort && mockPort <= 65535 && mockPort !== port),
    "Mixed turns require a distinct --mock-port >= 40000",
  );
  const env = createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });
  const log = createWriteStream(path.join(output, "gateway.log"));
  let gateway: ChildProcess | undefined;
  let provider: ChildProcess | undefined;
  const peers: ReturnType<typeof createGatewayWsClient>[] = [];
  let failure: Error | undefined;
  let closing = false;
  const frames: Array<{ client: number; payload: unknown }> = [];
  const key = (index: number) => `agent:main:team-shape-session-${index}`;
  // Shared visible roots, each with seeded descendants; exclude the fixture's draft rows.
  const keys = Array.from({ length: keyCount }, (_, i) => key(Math.floor(i / 7) * 10 + (i % 7)));
  const subscription = { sessionKeys: keys.slice(0, 1), passiveSessionKeys: keys.slice(1) };
  function snapshotState() {
    const latest = Array.from({ length: clients }, () => new Map<string, unknown>());
    for (const frame of frames) {
      assert(isRecord(frame.payload) && isRecord(frame.payload.sessions));
      for (const [sessionKey, snapshot] of Object.entries(frame.payload.sessions)) {
        latest[frame.client]!.set(sessionKey, snapshot);
      }
    }
    return latest.map((sessions, client) => {
      for (const sessionKey of keys) {
        assert(sessions.has(sessionKey), `Client ${client} did not receive ${sessionKey}`);
      }
      return {
        client,
        sessions: [...sessions].toSorted(([left], [right]) => left.localeCompare(right)),
      };
    });
  }
  function snapshotHash(state: ReturnType<typeof snapshotState>) {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
  }
  async function command(action: string, payload: Record<string, unknown> = {}) {
    assert(gateway);
    const child = gateway;
    return await new Promise<BenchReply>((resolve, reject) => {
      const timeoutMs =
        action === "ready"
          ? Math.max(
              startupTimeout,
              values["start-at"] ? integer(values["start-at"], "--start-at") - Date.now() : 0,
            )
          : 180000;
      const timeout = setTimeout(
        () => finish(new Error(`Benchmark ${action} timed out`)),
        timeoutMs,
      );
      function finish(value: BenchReply | Error) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (value instanceof Error) {
          reject(value);
        } else {
          resolve(value);
        }
      }
      function onMessage(message: unknown) {
        if (isRecord(message) && message.channel === channel && message.action === action) {
          finish(
            message.error
              ? new Error(
                  typeof message.error === "string" ? message.error : JSON.stringify(message.error),
                )
              : {
                  notifications: Number(message.notifications ?? 0),
                  ...(isRecord(message.mixed) ? { mixed: message.mixed } : {}),
                  checks: isRecord(message.checks)
                    ? Object.fromEntries(
                        Object.entries(message.checks).map(([name, count]) => [
                          name,
                          Number(count),
                        ]),
                      )
                    : undefined,
                  scopeCount: Number(message.scopeCount ?? 0),
                  pendingScopes: Number(message.pendingScopes ?? 0),
                  drainMs: Number(message.drainMs ?? 0),
                },
          );
        }
      }
      function onExit() {
        finish(new Error(`Gateway exited before ${action}; inspect ${output}`));
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      if (action !== "ready") {
        child.send({ ...payload, channel, action });
      }
    });
  }
  async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
    if (failure) {
      throw failure;
    }
    const started = performance.now();
    const response = await peer.request(method, params, 60000);
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return { elapsedMs: performance.now() - started, payload: response.payload };
  }
  async function cleanup() {
    closing = true;
    for (const peer of peers) {
      peer.close();
    }
    if (gateway) {
      await stopChild(gateway, { teardownGraceMs: 30000, killGraceMs: 2000 });
    }
    if (provider) {
      await stopChild(provider);
    }
    await new Promise<void>((resolve) => {
      log.end(resolve);
    });
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130));
    });
  }
  function summarize(samples: number[]) {
    const sorted = samples.toSorted((a, b) => a - b);
    return {
      count: sorted.length,
      meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted.at(-1),
    };
  }
  function familyBytes(profilePath: string) {
    const profile: HeapProfiler.SamplingHeapProfile = JSON.parse(readFileSync(profilePath, "utf8"));
    const leaves: Record<string, number> = {};
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, owned = false): number => {
      const family =
        owned ||
        /control-ui-session-(?:task-prs|pr-read|pr-subscriptions|pr-prepared-read)/.test(
          node.callFrame.url,
        );
      if (family && node.selfSize) {
        const { functionName, url, lineNumber, columnNumber } = node.callFrame;
        const leaf = `${functionName || "(anonymous)"}@${url.split("/").at(-1)}:${lineNumber + 1}:${columnNumber + 1}`;
        leaves[leaf] = (leaves[leaf] ?? 0) + node.selfSize;
      }
      return (
        (family ? node.selfSize : 0) +
        node.children.reduce((sum, child) => sum + visit(child, family), 0)
      );
    };
    return { bytes: visit(profile.head), leaves };
  }
  const turnText = "Synthetic task PR measurement complete.";
  const spawnLabel = `session-pr-benchmark-child-${process.pid}`;
  const receiptNumber = 900000000 + process.pid;
  let turnSequence = 0;
  let measuredTurns = 0;
  let spawnedChild: Record<string, unknown> | undefined;
  let publication: Record<string, unknown> | undefined;
  async function runTurn(
    sessionKey = key(4991),
    message = "Reply with the synthetic measurement text.",
  ) {
    const started = performance.now();
    const sent = await rpc(peers[0]!, "chat.send", {
      sessionKey,
      message,
      idempotencyKey: `session-pr-bench-${process.pid}-${++turnSequence}`,
    });
    assert(isRecord(sent.payload) && typeof sent.payload.runId === "string");
    const done = await rpc(peers[0]!, "agent.wait", {
      runId: sent.payload.runId,
      timeoutMs: 60000,
    });
    assert(isRecord(done.payload) && done.payload.status === "ok", JSON.stringify(done.payload));
    return performance.now() - started;
  }
  try {
    if (turnEvery) {
      const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
      assert.equal(
        config.models?.providers?.openai?.baseUrl,
        `http://127.0.0.1:${mockPort}/v1`,
        "Mixed fixture must target its local mock provider",
      );
      if (mixed) {
        assert.equal(config.tools?.toolSearch, false, "Mixed fixture needs direct native tools");
        assert.equal(config.tools?.codeMode?.enabled, false, "Mixed fixture needs Code Mode off");
      }
      const responseControl = path.join(output, "mock-response.json");
      writeFileSync(responseControl, JSON.stringify({ text: turnText }));
      provider = spawn(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          mixed
            ? "scripts/perf/session-pr-invalidation-provider.ts"
            : "scripts/e2e/mock-openai-server.mjs",
        ],
        {
          env: {
            PATH: process.env.PATH,
            MOCK_PORT: String(mockPort),
            MOCK_SPAWN_LABEL: spawnLabel,
            MOCK_RESPONSE_CONTROL: responseControl,
            MOCK_REQUEST_LOG: path.join(output, "mock-requests.jsonl"),
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const child = provider;
      child.stderr?.pipe(log, { end: false });
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.off("error", onError);
          child.off("exit", onExit);
          child.stdout?.off("data", onData);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) => finish(new Error(`Mock provider exited ${code}`));
        const onData = (chunk: Buffer) => {
          if (chunk.toString().includes(`mock-openai listening on ${mockPort}`)) {
            finish();
          }
        };
        const timer = setTimeout(() => finish(new Error("Mock provider did not listen")), 30000);
        child.once("error", onError);
        child.once("exit", onExit);
        child.stdout?.on("data", onData);
      });
      provider.once("exit", (code) => {
        if (!closing) {
          failure ??= new Error(`Mock provider exited ${code}`);
        }
      });
    }
    gateway = spawn(
      process.execPath,
      [
        ...(values["trace-gc"] ? ["--trace-gc-nvp"] : []),
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(import.meta.url),
        "--child",
        "--port",
        String(port),
        ...(values["owner-suffix"] ? ["--owner-suffix", values["owner-suffix"]] : []),
        ...(values["count-checks"] ? ["--count-checks"] : []),
        ...(mixed ? ["--mixed-invalidation"] : []),
      ],
      {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    gateway.stdout?.pipe(log, { end: false });
    const errors = createWriteStream(path.join(output, "gateway-stderr.log"));
    gateway.stderr?.pipe(errors);
    await command("ready");
    const readiness = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: performance.now(),
      deadlineAt: performance.now() + startupTimeout,
      isDone: () => gateway?.exitCode != null || gateway?.signalCode != null,
    });
    assert.equal(readiness.status, 200, "Gateway sidecars did not become ready");
    for (let index = 0; index < clients; index++) {
      const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
      const peer = createGatewayWsClient({
        url: `ws://127.0.0.1:${port}`,
        onEvent(event) {
          if (event.event === "connect.challenge" && isRecord(event.payload)) {
            challenge.resolve({ nonce: String(event.payload.nonce), ts: Number(event.payload.ts) });
          }
          if (event.event === "controlUi.sessionPullRequests.changed") {
            frames.push({ client: index, payload: event.payload });
          }
        },
      });
      peer.ws.on("error", (error) => {
        failure ??= error;
      });
      peer.ws.on("close", () => {
        if (!closing) {
          failure ??= new Error("Unexpected subscriber disconnect");
        }
      });
      peers.push(peer);
      await peer.waitOpen();
      const { nonce, ts } = await challenge.promise;
      const pair = generateKeyPairSync("ed25519");
      const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
        pair.publicKey.export({ type: "spki", format: "pem" }),
      );
      const deviceId = createHash("sha256")
        .update(Buffer.from(publicKey, "base64url"))
        .digest("hex");
      const client = { id: "gateway-client", version: "dev", platform: "web", mode: "backend" };
      const scopes = ["operator.admin", "operator.read", "operator.write"];
      await rpc(peer, "connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes,
        caps: [],
        device: {
          id: deviceId,
          publicKey,
          nonce,
          signedAt: ts,
          signature: signEd25519Payload(
            pair.privateKey.export({ type: "pkcs8", format: "pem" }),
            buildDeviceAuthPayloadV3({
              deviceId,
              clientId: client.id,
              clientMode: client.mode,
              platform: client.platform,
              role: "operator",
              scopes,
              signedAtMs: ts,
              nonce,
            }),
          ),
        },
      });
    }
    if (mixed) {
      for (const sessionKey of keys.slice(0, 3)) {
        const described = await rpc(peers[0]!, "sessions.describe", { key: sessionKey });
        assert(isRecord(described.payload) && isRecord(described.payload.session));
        const expectedSessionId = described.payload.session.sessionId;
        assert(typeof expectedSessionId === "string");
        await rpc(peers[0]!, "sessions.patch", {
          key: sessionKey,
          expectedSessionId,
          archived: false,
        });
      }
    }
    // Long-lived connection work is not part of the subscription owner's completion barrier.
    await command("capture");
    for (const peer of peers) {
      const result = await rpc(peer, "controlUi.sessionPullRequests.subscribe", subscription);
      assert(isRecord(result.payload) && result.payload.subscribed === true);
    }
    await delay(2000);
    const setupSettlement = await command("arm");
    for (const peer of peers) {
      await rpc(peer, "sessions.describe", { key: keys[0] });
    }
    const setupState = snapshotState();
    const setupSnapshotHash = snapshotHash(setupState);
    writeFileSync(path.join(output, "setup-snapshots.json"), JSON.stringify(setupState));
    writeFileSync(path.join(output, "setup-frames.json"), JSON.stringify(frames));
    for (let index = 0; index < 10; index++) {
      await rpc(peers[0]!, "sessions.patch", { key: key(4991), [mutation]: `warmup-${index % 2}` });
    }
    const warmupSettlement = await command("settle");
    if (turnEvery) {
      // Warm the same session contexts exercised by the measured turns.
      await Promise.all(
        (mixed ? keys.slice(0, 3) : [key(4991)]).map((sessionKey) => runTurn(sessionKey)),
      );
      await command("settle");
    }
    await delay(integer(values["warmup-ms"], "--warmup-ms", 0));
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at");
      assert(Date.now() < startAt, "Gateway setup missed the paired start time");
      await delay(startAt - Date.now());
    }
    const subscribeLatency: number[] = [];
    if (values["count-checks"]) {
      await command("start");
    }
    for (let index = 0; index < subscribes; index++) {
      subscribeLatency.push(
        (
          await rpc(
            peers[index % clients]!,
            "controlUi.sessionPullRequests.subscribe",
            subscription,
          )
        ).elapsedMs,
      );
    }
    const preMeasurementSettlement = await command("settle");
    const subscriptionChecks = values["count-checks"] ? (await command("stop")).checks : undefined;
    for (const peer of peers) {
      await rpc(peer, "sessions.describe", { key: keys[0] });
    }
    const initialState = snapshotState();
    const initialSnapshotHash = snapshotHash(initialState);
    const initialFrameCount = frames.length;
    writeFileSync(path.join(output, "initial-snapshots.json"), JSON.stringify(initialState));
    writeFileSync(path.join(output, "initial-frames.json"), JSON.stringify(frames));
    for (const { client, sessions } of initialState) {
      for (const [sessionKey, snapshot] of sessions) {
        assert(isRecord(snapshot));
        assert.equal(snapshot.status, "ready", `Client ${client} ${sessionKey} is not ready`);
        assert(Array.isArray(snapshot.taskPullRequests));
        assert.equal(typeof snapshot.taskPullRequestCount, "number");
      }
    }
    if (values["start-at"]) {
      const notifyAt = integer(values["start-at"], "--start-at") + 30000;
      assert(Date.now() < notifyAt, "Subscribe phase missed the paired notification start");
      await delay(notifyAt - Date.now());
    }
    const notifyLatency: number[] = [];
    const turnLatency: number[] = [];
    const listLatency: number[] = [];
    const notifySettlementLatency: number[] = [];
    const schedulingDelay: number[] = [];
    const profilePath = path.join(output, "notify.heapprofile");
    let finalSettlement: BenchReply | undefined;
    await command("start");
    const measuredStarted = performance.now();
    const cpuProfilePath = values["cpu-profile"] ? path.join(output, "notify.cpuprofile") : null;
    if (cpuProfilePath) {
      await controlGatewayProfile(gateway, "cpu", "start", cpuProfilePath);
    }
    let allocation: Awaited<ReturnType<typeof measureGatewayAllocations>>;
    try {
      allocation = await measureGatewayAllocations(gateway, profilePath, operations, async () => {
        const start = performance.now();
        for (let index = 0; index < operations; index++) {
          const scheduled = start + index * interval;
          await delay(Math.max(0, scheduled - performance.now()));
          schedulingDelay.push(Math.max(0, performance.now() - scheduled));
          const started = performance.now();
          notifyLatency.push(
            (
              await rpc(peers[0]!, "sessions.patch", {
                key: key(4991),
                [mutation]: `measure-${index % 2}`,
              })
            ).elapsedMs,
          );
          if (listEvery && index % listEvery === 0) {
            const page = await rpc(peers[index % clients]!, "sessions.list", {
              limit: 200,
              rowMode: "sidebar",
              archived: "all",
            });
            assert(isRecord(page.payload) && Array.isArray(page.payload.sessions));
            assert(page.payload.sessions.length > 0, "Sidebar selection returned no rows");
            listLatency.push(page.elapsedMs);
          }
          if (turnEvery && index % turnEvery === 0) {
            const samples = mixed
              ? await Promise.all(keys.slice(0, 3).map((sessionKey) => runTurn(sessionKey)))
              : [await runTurn()];
            measuredTurns += samples.length;
            turnLatency.push(...samples);
          }
          if (mixed && index === Math.floor(operations / 3)) {
            turnLatency.push(
              await runTurn(
                keys[0],
                "SESSION_PR_SPAWN_ONCE: Spawn the synthetic child, then reply with the synthetic measurement text.",
              ),
            );
            measuredTurns++;
            spawnedChild = (await command("inspect-child", { label: spawnLabel })).mixed;
            assert(
              spawnedChild &&
                spawnedChild.requesterSessionKey === keys[0] &&
                typeof spawnedChild.runId === "string",
            );
            const childDone = await rpc(peers[0]!, "agent.wait", {
              runId: spawnedChild.runId,
              timeoutMs: 60000,
            });
            assert(
              isRecord(childDone.payload) && childDone.payload.status === "ok",
              JSON.stringify(childDone.payload),
            );
          }
          if (mixed && index === Math.floor((operations * 2) / 3)) {
            publication = (await command("publish", { sessionKey: keys[1], receiptNumber })).mixed;
            assert(typeof publication?.publishedUrl === "string");
          }
          finalSettlement = await command("settle");
          notifySettlementLatency.push(performance.now() - started);
        }
      });
    } finally {
      if (cpuProfilePath) {
        await controlGatewayProfile(gateway, "cpu", "stop", cpuProfilePath);
      }
    }
    const measuredElapsedMs = performance.now() - measuredStarted;
    const { notifications, checks } = await command("stop");
    assert(notifications >= operations, "The stored-row notification path was not exercised");
    const parentSelections = (snapshot: typeof allocation.sessionRowSelections.before) =>
      snapshot?.selections.reduce(
        (total, item) => total + (item.kind === "parent" ? item.calls : 0),
        0,
      ) ?? 0;
    assert(
      parentSelections(allocation.sessionRowSelections.before) > 0,
      "Subscription setup did not exercise parent selection",
    );
    await delay(100);
    const promotion = values["trace-gc"]
      ? readGatewayGcTrace(path.join(output, "gateway.log"), profilePath)
      : null;
    const family = familyBytes(profilePath);
    // A response on each transport also consumes all earlier frames sent after settlement.
    for (const peer of peers) {
      await rpc(peer, "sessions.describe", { key: keys[0] });
    }
    let mockHealth: unknown;
    if (turnEvery) {
      mockHealth = await (await fetch(`http://127.0.0.1:${mockPort}/health`)).json();
      assert(
        isRecord(mockHealth) &&
          isRecord(mockHealth.requests) &&
          isRecord(mockHealth.requests.ingress),
      );
      assert(
        Number(mockHealth.requests.ingress.responses) >= turnLatency.length + 1,
        "Every turn must reach the mock provider",
      );
      if (mixed) {
        assert(mockHealth.spawnCalls === 1, "The mock must issue exactly one spawn call");
        assert(
          Number(mockHealth.maxConcurrentStreams) >= 3,
          "At least three model streams must overlap",
        );
        assert(
          Number(mockHealth.streamChunks) >= measuredTurns * 40,
          "The stream workload must emit incremental deltas",
        );
        assert(spawnedChild && typeof spawnedChild.childSessionKey === "string");
        const childHistory = await rpc(peers[0]!, "chat.history", {
          sessionKey: spawnedChild.childSessionKey,
          limit: 10,
        });
        assert(
          JSON.stringify(childHistory.payload).includes(turnText),
          "Native child must persist its provider reply",
        );
      }
      const history = await rpc(peers[0]!, "chat.history", {
        sessionKey: mixed ? keys[0] : key(4991),
        limit: 10,
      });
      assert(
        JSON.stringify(history.payload).includes(turnText),
        "Mock response must appear in chat history",
      );
    }
    const finalState = snapshotState();
    const finalSnapshotHash = snapshotHash(finalState);
    writeFileSync(path.join(output, "frames.json"), JSON.stringify(frames));
    writeFileSync(
      path.join(output, "snapshots.json"),
      JSON.stringify({ initialState, finalState }),
    );
    if (mixed) {
      assert(
        publication && spawnedChild,
        "The mixed run must finish its publication and child work",
      );
      for (const client of finalState) {
        const snapshot = client.sessions.find(([sessionKey]) => sessionKey === keys[1])?.[1];
        assert(
          JSON.stringify(snapshot).includes(String(publication.publishedUrl)),
          "Each client must receive the committed PR receipt",
        );
        for (const [sessionKey, value] of client.sessions) {
          if (sessionKey === keys[0] || sessionKey === keys[1]) {
            continue;
          }
          assert.deepEqual(
            value,
            initialState[client.client]!.sessions.find(
              ([savedKey]) => savedKey === sessionKey,
            )?.[1],
            "Unrelated PR snapshots must stay unchanged",
          );
        }
      }
    } else {
      assert.equal(
        finalSnapshotHash,
        initialSnapshotHash,
        `Unrelated ${mutation} writes changed PR snapshots`,
      );
    }
    const result = {
      format: "session-pr-subscriptions-v1",
      readiness,
      setupSettlement,
      warmupSettlement,
      preMeasurementSettlement,
      finalSettlement,
      revision: values.revision ?? null,
      traceGc: values["trace-gc"],
      countChecks: values["count-checks"],
      cpuProfile: cpuProfilePath ? readGatewayCpuProfile(cpuProfilePath) : null,
      mixedInvalidation: mixed,
      measuredElapsedMs,
      measuredTurns,
      spawnedChild,
      publication,
      checksPerMinute: checks
        ? Object.fromEntries(
            Object.entries(checks).map(([counterName, count]) => [
              counterName,
              (count * 60000) / measuredElapsedMs,
            ]),
          )
        : undefined,
      subscriptionChecks,
      checks,
      turnEvery,
      turnLatency: turnLatency.length ? summarize(turnLatency) : null,
      mockHealth,
      warmupMs: Number(values["warmup-ms"]),
      startupTimeoutMs: startupTimeout,
      testedOwners: Object.fromEntries(
        benchmarkOwners.map((name) => {
          const suffix = values["owner-suffix"] ? `.${values["owner-suffix"]}` : "";
          const owner = new URL(`../../src/gateway/${name}${suffix}.ts`, import.meta.url);
          return [name, createHash("sha256").update(readFileSync(owner)).digest("hex")];
        }),
      ),
      fixture: {
        sessions: fixture.sessionCount,
        runs: fixture.retainedRuns,
        agentDatabaseBytes: fixture.agentDatabaseBytes,
      },
      clients,
      mutation,
      keysPerClient: keyCount,
      operations,
      intervalMs: interval,
      listEvery,
      notifications,
      subscribeLatency: summarize(subscribeLatency),
      notifyRpcLatency: summarize(notifyLatency),
      listLatency: listLatency.length ? summarize(listLatency) : null,
      notifySettlementLatency: summarize(notifySettlementLatency),
      schedulingDelay: summarize(schedulingDelay),
      setupSnapshotHash,
      initialSnapshotHash,
      finalSnapshotHash,
      snapshotsBeforeMeasurement: initialFrameCount,
      snapshotsAfterMeasurement: frames.length,
      allocation,
      promotion,
      familyAllocatedBytes: family.bytes,
      familyLeafAllocatedBytes: family.leaves,
      familyShare: family.bytes / allocation.sampledAllocatedBytes,
      allocatedBytesPerNotification: allocation.sampledAllocatedBytes / notifications,
      allocatedBytesPerNotificationPerTab:
        allocation.sampledAllocatedBytes / notifications / clients,
      familyBytesPerNotificationPerTab: family.bytes / notifications / clients,
    };
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    await cleanup();
  }
}
