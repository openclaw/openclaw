// Owner microbenchmark, not a whole-Gateway load test. Run separate CPU and allocation passes:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-pr-currency-measure.ts
//   --output .local/currency.json [--allocations] [--base-owner-suffix base]
// --base-owner-suffix compares control-ui-session-pr-{read,source,subscriptions}.<suffix>.ts.
// Subscription snapshots must expose the current four-argument replace API.
// --base-projection-suffix compares session-row-projection.<suffix>.ts (redirect its
// materialize import to the matching baseline snapshot). --captures isolates row capture.
// --unrelated-churn updates an unrelated archived session between batches of 64 validations;
// baseline read imports must point at control-ui-session-task-prs.<suffix>.ts as well.
// --subscribe measures real subscribe handlers plus settled passive watcher work.
// Its baseline also needs server-methods/control-ui.<suffix>.ts.
// --subscriptions measures passive watcher polls with a runtime publication per poll;
// iterations must be divisible by --clients and count watcher validations, not polls.
// --notifications --clients 65 measures participant-fact notifications (one event per turn);
// --idle supplies the matching event-loop-only control. Iterations count events/idle turns.
// Notification arms install and stop their subscriptions outside each sample, so global
// publications never exercise the other arm's watchers. Report checks separately from events.
// Both arms share one prepared fixture; five pairs alternate AB/BA without rebuilding state.
// Fixture setup is excluded: 10k persisted rows, 40 configured agents, 64 retained readers.
// Each reader has four shared descendants created by a different profile.
// Each arm acquires one physical source, then checks it at every reader's final assertion.
// Preserve every arm, report host load, and interpret allocation-mode timing separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type {
  ControlUiSessionPrRead,
  ControlUiSessionPrTarget,
} from "../../src/gateway/control-ui-session-pr-read.js";
import type { GatewayClient } from "../../src/gateway/server-methods/client-types.js";
import { createControlUiRequestOptions } from "../../src/gateway/server-methods/control-ui-request.test-support.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../src/gateway/server-methods/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
    subscriptions: { type: "boolean", default: false },
    subscribe: { type: "boolean", default: false },
    notifications: { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    clients: { type: "string", default: "64" },
    "unrelated-churn": { type: "boolean", default: false },
    "base-owner-suffix": { type: "string" },
    "base-projection-suffix": { type: "string" },
    captures: { type: "boolean", default: false },
    pairs: { type: "string", default: "5" },
    output: { type: "string" },
  },
});
const integer = (name: "iterations" | "warmup" | "pairs" | "clients") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const warmup = integer("warmup");
const pairs = integer("pairs");
const watchSubscriptions = values.subscriptions || values.subscribe || values.notifications;
assert(
  [values.subscriptions, values.subscribe, values.notifications].filter(Boolean).length <= 1,
  "Choose --subscribe, --subscriptions, or --notifications",
);
assert(!values.idle || values.notifications, "--idle requires --notifications");
assert(!(values.captures && watchSubscriptions), "Choose --captures or subscription work");
assert(
  !values["unrelated-churn"] || (!watchSubscriptions && !values.captures),
  "--unrelated-churn uses reader mode",
);
assert(!(values["base-owner-suffix"] && values["base-projection-suffix"]));
assert(global.gc, "Run Node with --expose-gc");
assert(!values["base-owner-suffix"] || /^[a-z0-9-]+$/.test(values["base-owner-suffix"]));
assert(!values["base-projection-suffix"] || /^[a-z0-9-]+$/.test(values["base-projection-suffix"]));
const baseSuffix = values["base-owner-suffix"] ?? values["base-projection-suffix"];
const sources = [
  ...(baseSuffix ? [{ name: "base", suffix: `.${baseSuffix}` }] : []),
  { name: "candidate", suffix: "" },
].map(({ name, suffix }) => {
  const projectionUrl = new URL(
    `../../src/gateway/session-row-projection${values["base-projection-suffix"] ? suffix : ""}.ts`,
    import.meta.url,
  );
  const materializeUrl = new URL(
    `../../src/gateway/session-row-projection-materialize${values["base-projection-suffix"] ? suffix : ""}.ts`,
    import.meta.url,
  );
  const ownerSuffix = values["base-projection-suffix"] ? "" : suffix;
  const url = new URL(
    `../../src/gateway/control-ui-session-pr-read${ownerSuffix}.ts`,
    import.meta.url,
  );
  const sourceUrl = new URL(
    `../../src/gateway/control-ui-session-pr-source${ownerSuffix}.ts`,
    import.meta.url,
  );
  const subscriptionsUrl = new URL(
    `../../src/gateway/control-ui-session-pr-subscriptions${ownerSuffix}.ts`,
    import.meta.url,
  );
  const handlerUrl = new URL(
    `../../src/gateway/server-methods/control-ui${ownerSuffix}.ts`,
    import.meta.url,
  );
  const taskUrl = new URL(
    `../../src/gateway/control-ui-session-task-prs${values["unrelated-churn"] ? ownerSuffix : ""}.ts`,
    import.meta.url,
  );
  return {
    name,
    taskUrl,
    taskSha256: createHash("sha256").update(readFileSync(taskUrl)).digest("hex"),
    projectionUrl,
    projectionSha256: createHash("sha256").update(readFileSync(projectionUrl)).digest("hex"),
    materializeUrl,
    materializeSha256: createHash("sha256").update(readFileSync(materializeUrl)).digest("hex"),
    url,
    handlerUrl,
    handlerSha256: values.subscribe
      ? createHash("sha256").update(readFileSync(handlerUrl)).digest("hex")
      : undefined,
    sha256: createHash("sha256").update(readFileSync(url)).digest("hex"),
    sourceUrl,
    sourceSha256: createHash("sha256").update(readFileSync(sourceUrl)).digest("hex"),
    subscriptionsUrl,
    subscriptionsSha256: watchSubscriptions
      ? createHash("sha256").update(readFileSync(subscriptionsUrl)).digest("hex")
      : undefined,
  };
});
const scratch = path.resolve(".local");
mkdirSync(scratch, { recursive: true });
const stateDir = mkdtempSync(path.join(scratch, "pr-currency-"));
const configPath = path.join(stateDir, "openclaw.json");
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(stateDir, directory));
}
const sessionCount = 10_000;
const readerCount = integer("clients");
if (watchSubscriptions && !values.notifications) {
  assert.equal(iterations % readerCount, 0, "--iterations must be divisible by --clients");
}
const childrenPerRoot = 4;
assert(readerCount * (childrenPerRoot + 1) < sessionCount, "Too many clients for the fixture");
const agentIds = ["main", ...Array.from({ length: 39 }, (_, i) => `worker-${i}`)];
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
  },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
      },
    },
  },
};
writeFileSync(configPath, JSON.stringify(cfg));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const [
  { setRuntimeConfigSnapshot },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
  { closeOpenClawStateDatabaseAsync },
  { ensureProfileForEmail },
  { prepareGatewayRecipientProfile },
  { GatewayScheduler },
  { sessionChanges },
  { upsertSessionEntryCore },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/state/user-profiles.js"),
  import("../../src/gateway/expected-profile.js"),
  import("../../src/infra/gateway-scheduler.js"),
  import("../../src/sessions/session-row-changes.js"),
  import("../../src/config/sessions/session-accessor.js"),
]);
const owners = await Promise.all(
  sources.map(async (source) => {
    const {
      createSessionRowProjection,
    }: typeof import("../../src/gateway/session-row-projection.js") = await import(
      source.projectionUrl.href
    );
    const {
      createControlUiSessionPrRead,
    }: typeof import("../../src/gateway/control-ui-session-pr-read.js") = await import(
      source.url.href
    );
    const {
      withControlUiSessionPrSource,
    }: typeof import("../../src/gateway/control-ui-session-pr-source.js") = await import(
      source.sourceUrl.href
    );
    const subscriptions:
      | typeof import("../../src/gateway/control-ui-session-pr-subscriptions.js")
      | undefined = watchSubscriptions ? await import(source.subscriptionsUrl.href) : undefined;
    const handlers: typeof import("../../src/gateway/server-methods/control-ui.js") | undefined =
      values.subscribe ? await import(source.handlerUrl.href) : undefined;
    return {
      ...source,
      createSessionRowProjection,
      createControlUiSessionPrRead,
      withControlUiSessionPrSource,
      subscriptions,
      handler: handlers?.controlUiHandlers["controlUi.sessionPullRequests.subscribe"],
    };
  }),
);
const profile = ensureProfileForEmail("currency-reader@example.test");
const childCreator = ensureProfileForEmail("currency-child-creator@example.test");
setRuntimeConfigSnapshot(cfg);
const keyFor = (index: number) => `agent:main:currency-${index}`;
const projections: import("../../src/gateway/session-row-projection.js").SessionRowProjection[] =
  [];
const inspector = new Session();
let inspectorConnected = false;
const gc: { start: number; ms: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({ start: entry.startTime, ms: entry.duration });
  }
});
const schedulers: InstanceType<typeof GatewayScheduler>[] = [];
const stopSubscriptions: (() => Promise<void>)[] = [];
let stopNotificationArm: (() => Promise<void>) | undefined;
try {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < sessionCount; index++) {
        const child = index >= readerCount && index < readerCount * (childrenPerRoot + 1);
        const entry: SessionEntry = {
          sessionId: `currency-session-${index}`,
          updatedAt: 1_700_000_000_000 + index,
          spawnedCwd: "/synthetic/currency-workspace",
          createdActor: {
            type: "human",
            source: "profile",
            id: child ? childCreator.id : profile.id,
          },
          ...(child ? { parentSessionKey: keyFor((index - readerCount) % readerCount) } : {}),
          ...(index >= readerCount * (childrenPerRoot + 1)
            ? { archivedAt: 1_700_000_000_001 }
            : {}),
        };
        writeSessionEntry(database, keyFor(index), entry);
      }
    },
    { agentId: "main" },
  );
  const arms = [];
  for (const owner of owners) {
    const projection = await owner.createSessionRowProjection({ cfg, modelCatalog: [] });
    projections.push(projection);
    await projection.prepareSelection();
    await projection.ensureMaterialized();
    const access = new AbortController();
    const reads: ControlUiSessionPrRead[] = [];
    const clients: GatewayClient[] = [];
    for (let index = 0; index < readerCount; index++) {
      const client: GatewayClient = {
        connId: String(index),
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-control-ui",
            version: "synthetic",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
        },
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        internal: {
          operatorAccessAuthority: {
            signal: access.signal,
            assertCurrent: () => access.signal.throwIfAborted(),
          },
        },
      };
      prepareGatewayRecipientProfile(client);
      clients.push(client);
      const read = owner.createControlUiSessionPrRead({
        taskReceiptsOnly: watchSubscriptions,
        client,
        sessionKey: keyFor(index),
        getRuntimeConfig: () => cfg,
        getSessionRowProjection: () => projection,
        isCurrentClient: () => true,
      });
      assert(read);
      reads.push(read);
    }
    const targets = await Promise.all(reads.map((read) => read()));
    for (const target of targets) {
      assert(target?.assertCurrent);
      assert.equal(target.taskReceipts?.sessions.length, childrenPerRoot + 1);
    }
    const source = targets[0]!.readSource;
    assert(targets.every((target) => target?.readSource.path === source.path));
    let watcherChecks = 0;
    let prepare = async () => {};
    let cleanup = async () => {};
    let run = (count: number) =>
      owner.withControlUiSessionPrSource(source, async (assertSourceCurrent) => {
        for (let index = 0; index < count; index++) {
          if (values["unrelated-churn"] && index % readerCount === 0) {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: keyFor(sessionCount - 1) },
              { label: `Churn ${index}` },
            );
            await projection.ensureMaterialized();
          }
          const slot = index % readerCount;
          const target = await reads[slot]!();
          // Churn may reacquire a grant; its source and task audience must stay identical.
          assert.equal(
            values["unrelated-churn"] ? target?.identity : target,
            values["unrelated-churn"] ? targets[slot]?.identity : targets[slot],
          );
          assertSourceCurrent();
          target!.assertCurrent!();
        }
      });
    if (values.captures) {
      const queries = targets.map((target) => ({
        agentId: target!.params.agentId,
        key: target!.params.sessionKey,
        storePath: target!.readSource.path,
      }));
      const rows = queries.map((query) => projection.capture(query));
      run = async (count) => {
        for (let index = 0; index < count; index++) {
          const slot = index % readerCount;
          assert.equal(projection.capture(queries[slot]!), rows[slot]);
        }
      };
    }
    if (values.notifications && owner.subscriptions) {
      const subscriptionOwner = owner.subscriptions;
      const wrapped = new WeakMap<ControlUiSessionPrTarget, ControlUiSessionPrTarget>();
      const countedReads = reads.map((read): ControlUiSessionPrRead => async () => {
        const target = await read();
        if (!target) {
          return undefined;
        }
        let counted = wrapped.get(target);
        if (!counted) {
          counted = {
            ...target,
            assertCurrent: () => {
              watcherChecks++;
              target.assertCurrent!();
            },
          };
          wrapped.set(target, counted);
        }
        return counted;
      });
      prepare = async () => {
        assert(!stopNotificationArm, "Only one notification arm may subscribe");
        const scheduler = new GatewayScheduler();
        let publications = 0;
        const subscriptions = subscriptionOwner.createControlUiSessionPullRequestSubscriptions({
          scheduler,
          getSessionRowProjection: () => projection,
          broadcastToConnIds: () => publications++,
          isConnectionActive: () => true,
          prepareRead: async (connId) => countedReads[Number(connId)],
        });
        stopNotificationArm = async () => {
          await subscriptions.stop();
          await scheduler.stop();
        };
        for (let index = 0; index < readerCount; index++) {
          await subscriptions.replace(String(index), [], new Set(), new Set([keyFor(index)]));
        }
        assert.equal(publications, readerCount, "Each real subscription must publish its snapshot");
        watcherChecks = 0;
      };
      cleanup = async () => {
        await stopNotificationArm?.();
        stopNotificationArm = undefined;
      };
      run = async (count) => {
        for (let index = 0; index < count; index++) {
          if (!values.idle) {
            sessionChanges.emit({
              agentId: "main",
              storePath: source.path,
              sessionKey: keyFor(index % readerCount),
              scope: "session-entry",
              facts: { kind: "participants", projectionChanged: false },
            });
          }
          // Drain the owner's existing deferred pass, without adding a poll.
          await nextTurn();
        }
      };
    } else if (owner.subscriptions) {
      const scheduler = new GatewayScheduler();
      schedulers.push(scheduler);
      let publications = 0;
      const subscriptions = owner.subscriptions.createControlUiSessionPullRequestSubscriptions({
        scheduler,
        getSessionRowProjection: () => projection,
        broadcastToConnIds: () => {
          publications++;
        },
        isConnectionActive: () => true,
        prepareRead: async (connId) => {
          const read = reads[Number(connId)];
          assert(read, "Every request must have a real reader");
          return read;
        },
      });
      stopSubscriptions.push(subscriptions.stop);
      const replacements: Promise<void>[] = [];
      const requestSubscriptions = {
        ...subscriptions,
        replace: (...args: Parameters<typeof subscriptions.replace>) => {
          const pending = subscriptions.replace(...args);
          replacements.push(pending);
          return pending;
        },
      };
      const settleReplacements = async () => {
        await Promise.all(replacements.splice(0));
      };
      const requestOptions = createControlUiRequestOptions(() => cfg);
      const requests = owner.handler
        ? clients.map((client, index) => {
            const params = { sessionKeys: [], passiveSessionKeys: [keyFor(index)] };
            // This owner benchmark supplies only the context consumed by the subscribe RPC.
            const context = {
              controlUiSessionPullRequests: requestSubscriptions,
              logGateway: {
                warn: (message: string) => {
                  throw new Error(message);
                },
              },
            } satisfies Pick<GatewayRequestContext, "controlUiSessionPullRequests"> & {
              logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
            };
            const respond = (ok: boolean, payload: unknown) => {
              assert(ok);
              assert.deepEqual(payload, { subscribed: true });
            };
            return Object.assign(requestOptions(params, respond, { context }), {
              client,
              req: {
                type: "req" as const,
                id: String(index),
                method: "controlUi.sessionPullRequests.subscribe",
                params,
              },
            }) satisfies GatewayRequestHandlerOptions;
          })
        : [];
      if (owner.handler) {
        for (const request of requests) {
          await owner.handler(request);
        }
        await settleReplacements();
      } else {
        for (let index = 0; index < readerCount; index++) {
          await subscriptions.replace(String(index), [], new Set(), new Set([keyFor(index)]));
        }
      }
      assert.equal(publications, readerCount, "Each real subscription must publish its snapshot");
      run = async (count) => {
        for (let index = 0; index < Math.ceil(count / readerCount); index++) {
          if (owner.handler) {
            await Promise.all(requests.map((request) => Promise.resolve(owner.handler!(request))));
            // Include exactly the work scheduled by the request, without an extra poll.
            await settleReplacements();
          } else {
            sessionChanges.emit({
              agentId: "main",
              sessionKey: keyFor(index % readerCount),
              scope: "runtime",
            });
            await subscriptions.pollNow();
          }
        }
      };
    }
    await prepare();
    await run(warmup);
    await cleanup();
    arms.push({ owner, run, prepare, cleanup, watcherChecks: () => watcherChecks });
  }
  if (values.allocations) {
    inspector.connect();
    inspectorConnected = true;
  }
  const samples = [];
  for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 === 0 ? arms : arms.toReversed();
    for (const arm of order) {
      await arm.prepare();
      global.gc();
      await nextTurn();
      gc.length = 0;
      observer.takeRecords();
      observer.observe({ entryTypes: ["gc"] });
      if (values.allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const before = process.memoryUsage();
      const hostLoadBefore = os.loadavg();
      const cpuBefore = process.threadCpuUsage();
      const started = performance.now();
      await arm.run(iterations);
      const ended = performance.now();
      const cpu = process.threadCpuUsage(cpuBefore);
      const after = process.memoryUsage();
      const hostLoadAfter = os.loadavg();
      const sampled = values.allocations
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      await nextTurn();
      for (const entry of observer.takeRecords()) {
        gc.push({ start: entry.startTime, ms: entry.duration });
      }
      const measuredGc = gc.filter((entry) => entry.start >= started && entry.start < ended);
      const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((total, child) => total + allocationBytes(child), 0);
      const bytes = sampled ? allocationBytes(sampled.head) : undefined;
      samples.push({
        pair: pair + 1,
        arm: arm.owner.name,
        order: order.map(({ owner }) => owner.name),
        allocation:
          bytes === undefined
            ? null
            : {
                sampledBytes: bytes,
                ...(values.notifications
                  ? { bytesPerTurn: bytes / iterations }
                  : { bytesPerReadAndAssertion: bytes / iterations }),
              },
        cpu: {
          mainThreadMs: (cpu.user + cpu.system) / 1000,
          ...(values.notifications
            ? { microsecondsPerTurn: (cpu.user + cpu.system) / iterations }
            : { microsecondsPerReadAndAssertion: (cpu.user + cpu.system) / iterations }),
        },
        ...(values.notifications
          ? {
              work: {
                turns: iterations,
                notifications: values.idle ? 0 : iterations,
                watcherChecks: arm.watcherChecks(),
                notificationsPerSecond: values.idle ? 0 : (iterations * 1000) / (ended - started),
                watcherChecksPerSecond: (arm.watcherChecks() * 1000) / (ended - started),
              },
            }
          : {}),
        elapsedMs: ended - started,
        gc: {
          count: measuredGc.length,
          totalMs: measuredGc.reduce((total, entry) => total + entry.ms, 0),
          maxMs: Math.max(0, ...measuredGc.map((entry) => entry.ms)),
        },
        memory: { before, after },
        hostLoad: { before: hostLoadBefore, after: hostLoadAfter },
      });
      await arm.cleanup();
    }
  }
  for (const source of sources) {
    assert.equal(
      createHash("sha256").update(readFileSync(source.taskUrl)).digest("hex"),
      source.taskSha256,
      "Task audience owner changed during measurement",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(source.materializeUrl)).digest("hex"),
      source.materializeSha256,
    );
    assert.equal(
      createHash("sha256").update(readFileSync(source.projectionUrl)).digest("hex"),
      source.projectionSha256,
    );
    assert.equal(
      createHash("sha256").update(readFileSync(source.url)).digest("hex"),
      source.sha256,
      "Owner source changed during measurement",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(source.sourceUrl)).digest("hex"),
      source.sourceSha256,
      "Physical source owner changed during measurement",
    );
    if (values.subscribe) {
      assert.equal(
        createHash("sha256").update(readFileSync(source.handlerUrl)).digest("hex"),
        source.handlerSha256,
      );
    }
    if (watchSubscriptions) {
      assert.equal(
        createHash("sha256").update(readFileSync(source.subscriptionsUrl)).digest("hex"),
        source.subscriptionsSha256,
      );
    }
  }
  const result = {
    scope: values.captures
      ? "real resident row captures on Team-shaped state; no transport or whole-Gateway claim"
      : values.notifications
        ? "real subscription-owner participant notifications or idle control; no transport or production-frequency claim"
        : values.subscribe
          ? "real subscribe handler and settled owner work; no transport or whole-Gateway claim"
          : "real in-process PR reader, physical source and final currency assertions; no transport or whole-Gateway claim",
    node: process.version,
    owners: sources.map(
      ({
        name,
        url,
        sha256,
        sourceUrl,
        sourceSha256,
        taskSha256,
        subscriptionsSha256,
        handlerSha256,
        projectionUrl,
        projectionSha256,
        materializeUrl,
        materializeSha256,
      }) => ({
        name,
        path: url.pathname,
        sha256,
        sourcePath: sourceUrl.pathname,
        sourceSha256,
        taskSha256,
        subscriptionsSha256,
        handlerSha256,
        projectionPath: projectionUrl.pathname,
        projectionSha256,
        materializePath: materializeUrl.pathname,
        materializeSha256,
      }),
    ),
    workload: {
      sessionCount,
      configuredAgents: agentIds.length,
      readerCount,
      childrenPerRoot,
      iterations,
      warmup,
      pairs,
      subscriptions: values.subscriptions,
      subscribe: values.subscribe,
      notifications: values.notifications,
      idle: values.idle,
      unrelatedChurn: values["unrelated-churn"],
      captures: values.captures,
    },
    allocationMode: values.allocations,
    samples,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    writeFileSync(values.output, output);
  }
  process.stdout.write(output);
} finally {
  await stopNotificationArm?.();
  for (const stop of stopSubscriptions) {
    await stop();
  }
  for (const scheduler of schedulers) {
    await scheduler.stop();
  }
  observer.disconnect();
  if (inspectorConnected) {
    inspector.disconnect();
  }
  for (const projection of projections) {
    projection.dispose();
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  rmSync(stateDir, { recursive: true, force: true });
}
