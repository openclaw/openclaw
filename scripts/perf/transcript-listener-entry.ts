/** Diagnostic entry for the isolated transcript-listener Gateway workload. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryObjects, writeHeapSnapshot } from "node:v8";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.env.OPENCLAW_LISTENER_BASELINE;
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
    const replacement = baseline && path.join(baseline, relative);
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
let sampling = false;
let previousCpu = process.threadCpuUsage();
let previousTime = performance.now();
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("id" in message)) {
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
