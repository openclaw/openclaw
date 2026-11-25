/** Diagnostic entry for the isolated transcript-listener Gateway workload. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryObjects, writeHeapSnapshot } from "node:v8";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.env.OPENCLAW_LISTENER_BASELINE;
const surge = process.env.OPENCLAW_LISTENER_SURGE === "1";
const surgeOwnerPaths = [
  "src/gateway/session-row-presentation.ts",
  "src/gateway/session-event-projection.ts",
  "src/gateway/session-row-delta-fields.ts",
];
const sourceHead = surge
  ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  : undefined;
const surgeOwners = new Map(
  surge
    ? surgeOwnerPaths.map((relative) => {
        const selected = baseline ? path.join(baseline, relative) : path.join(root, relative);
        const hash = (file: string) =>
          createHash("sha256").update(readFileSync(file)).digest("hex");
        return [
          relative,
          {
            path: relative,
            route: baseline ? "baseline" : "source",
            sha256: hash(selected),
            sourceSha256: hash(path.join(root, relative)),
            loads: 0,
          },
        ];
      })
    : [],
);
if (surge && baseline) {
  assert.match(process.env.OPENCLAW_LISTENER_BASELINE_REVISION ?? "", /^[a-f0-9]{40}$/);
}
const failEvery = Number(process.env.OPENCLAW_LISTENER_FAIL_EVERY ?? 0);
let cleanups = 0;
Object.assign(globalThis, {
  transcriptListenerFailCleanup: () => failEvery > 0 && ++cleanups % failEvery === 0,
});
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    const relative = path.relative(root, fileURLToPath(url));
    const selected = surgeOwners.get(relative);
    if (selected) {
      selected.loads++;
    }
    const replacement = baseline && (!surge || selected) && path.join(baseline, relative);
    const inject =
      failEvery > 0 &&
      relative === "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.ts";
    if ((!replacement || !existsSync(replacement)) && !inject) {
      return nextLoad(url, context);
    }
    let source = readFileSync(
      replacement && existsSync(replacement) ? replacement : fileURLToPath(url),
      "utf8",
    );
    if (inject) {
      const call = "await params.onDrained?.();";
      assert(source.includes(call), "Cleanup fault-injection boundary moved");
      source = source.replace(
        call,
        `${call}\nif (globalThis.transcriptListenerFailCleanup()) throw new Error("Synthetic transcript cleanup failure");`,
      );
    }
    return {
      format: "module",
      source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const { SessionManager } = await import("../../src/agents/sessions/session-manager.ts");
const { AgentSession } = await import("../../src/agents/sessions/agent-session.ts");
const { Agent } = await import("../../packages/agent-core/src/agent.ts");
const { ModelRegistry } = await import("../../src/agents/sessions/model-registry.ts");
const { ContextEngineFactoryResources } =
  await import("../../src/context-engine/registry.resources.ts");
const profiler = new Session();
profiler.connect();
if (surge) {
  const { onGatewayWorkMetrics } = await import("../../src/infra/gateway-work-metrics.ts");
  let work: Parameters<Parameters<typeof onGatewayWorkMetrics>[0]>[0];
  let measuring = false;
  let minimumRunning = Infinity;
  let maximumRunning = 0;
  const unsubscribe = onGatewayWorkMetrics((snapshot) => {
    work = snapshot;
    if (measuring && snapshot) {
      minimumRunning = Math.min(minimumRunning, snapshot.sessions.running);
      maximumRunning = Math.max(maximumRunning, snapshot.sessions.running);
    }
  });
  let started = 0;
  let cpuStart = process.threadCpuUsage();
  let expectedTick = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalls: number[] = [];
  process.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("channel" in message) ||
      message.channel !== "listener-surge" ||
      !("id" in message) ||
      !("action" in message)
    ) {
      return;
    }
    void (async () => {
      assert(
        [...surgeOwners.values()].every(({ loads }) => loads > 0),
        "A surge owner module was not loaded",
      );
      const source = {
        sourceHead,
        baselineRevision: process.env.OPENCLAW_LISTENER_BASELINE_REVISION || undefined,
        owners: [...surgeOwners.values()],
      };
      let result: Record<string, unknown> = { work, source };
      if (message.action === "start") {
        assert(!measuring, "Surge measurement already started");
        if (process.env.OPENCLAW_LISTENER_ALLOCATIONS === "1") {
          await profiler.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        if (process.env.OPENCLAW_LISTENER_PROFILE) {
          await profiler.post("Profiler.enable");
          await profiler.post("Profiler.start");
        }
        minimumRunning = maximumRunning = work?.sessions.running ?? 0;
        started = performance.now();
        cpuStart = process.threadCpuUsage();
        expectedTick = started + 20;
        measuring = true;
        timer = setInterval(() => {
          const now = performance.now();
          if (now - expectedTick >= 250) {
            stalls.push(now - expectedTick);
          }
          expectedTick = now + 20;
        }, 20).unref();
      } else if (message.action === "stop") {
        assert(measuring, "Surge measurement was not started");
        const elapsedMs = performance.now() - started;
        const cpu = process.threadCpuUsage(cpuStart);
        measuring = false;
        clearInterval(timer);
        result = {
          work,
          source,
          elapsedMs,
          mainCpuMs: (cpu.user + cpu.system) / 1000,
          minimumRunning,
          maximumRunning,
          stalls250Ms: stalls,
          memory: process.memoryUsage(),
        };
        if (process.env.OPENCLAW_LISTENER_ALLOCATIONS === "1") {
          const { profile } = await profiler.post("HeapProfiler.stopSampling");
          const sum = (node: typeof profile.head): number =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          result.allocationBytes = sum(profile.head);
        }
        if (process.env.OPENCLAW_LISTENER_PROFILE) {
          const { profile } = await profiler.post("Profiler.stop");
          writeFileSync(process.env.OPENCLAW_LISTENER_PROFILE, JSON.stringify(profile));
        }
      } else {
        assert.equal(message.action, "sample");
      }
      process.send?.({ channel: "listener-surge", id: message.id, ...result });
    })().catch((error: unknown) =>
      process.send?.({ channel: "listener-surge", id: message.id, error: String(error) }),
    );
  });
  process.once("disconnect", () => {
    clearInterval(timer);
    unsubscribe();
  });
}
let sampling = false;
let previousCpu = process.threadCpuUsage();
let previousTime = performance.now();
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("id" in message) || "channel" in message) {
    return;
  }
  void (async () => {
    const cpu = process.threadCpuUsage(previousCpu);
    const elapsedMs = performance.now() - previousTime;
    let allocationBytes: number | undefined;
    if (sampling) {
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      const sum = (node: typeof profile.head): number =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      allocationBytes = sum(profile.head);
    }
    assert(global.gc, "Run the Gateway with --expose-gc");
    global.gc();
    const managers = queryObjects(SessionManager, { format: "count" });
    const sessions = queryObjects(AgentSession, { format: "count" });
    const agents = queryObjects(Agent, { format: "count" });
    const registries = queryObjects(ModelRegistry, { format: "count" });
    const factoryResources = queryObjects(ContextEngineFactoryResources, { format: "count" });
    global.gc();
    const listeners = Reflect.get(
      globalThis,
      Symbol.for("openclaw.internalSessionTranscriptListeners"),
    ) as Set<unknown> | undefined;
    const result = {
      id: message.id,
      listeners: listeners?.size ?? 0,
      managers,
      sessions,
      agents,
      registries,
      factoryResources,
      heapUsed: process.memoryUsage().heapUsed,
      cpuMs: (cpu.user + cpu.system) / 1000,
      elapsedMs,
      allocationBytes,
    };
    if ("snapshot" in message && typeof message.snapshot === "string") {
      writeHeapSnapshot(message.snapshot);
    }
    if (process.env.OPENCLAW_LISTENER_ALLOCATIONS === "1") {
      await profiler.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      sampling = true;
    }
    previousCpu = process.threadCpuUsage();
    previousTime = performance.now();
    process.send?.(result);
  })().catch((error: unknown) => process.send?.({ id: message.id, error: String(error) }));
});
process.channel?.unref();
const { registerInternalHook } = await import("../../src/hooks/internal-hooks.ts");
registerInternalHook("agent:bootstrap", () => {});
process.argv[1] = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
await import("../../src/entry.ts");
