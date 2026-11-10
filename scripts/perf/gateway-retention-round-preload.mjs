// Synthetic Gateway-only per-round measurement. Retained sampling is cumulative
// from the seeded baseline; allocation and uninstrumented timing use separate runs.
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

const targets = [
  "admitProviderRateLimitStream",
  "buildRequest",
  "buildOpenAIResponsesParams",
  "convertResponsesMessages",
  "convertMessage",
  "resolveResponsesContinuationRequest",
  "prepareCodingToolAssemblyAsync",
  "prepareEmbeddedSkills",
  "prepareEmbeddedAttemptBundleTools",
  "prepareEmbeddedAttemptSystemPrompt",
  "buildSystemPromptReport",
  "serializeLifecycle",
  "SessionManager",
  "SubagentRunMap",
  "SubagentSessionReadLookup",
  "registerSubagentRun",
  "createPluginInvocation",
  "createSessionActor",
  "putSessionRow",
  "presentSessionRow",
  "setTimeout",
];

function summarizeProfile(profile) {
  const sites = new Map();
  const inclusive = Object.fromEntries(targets.map((name) => [name, 0]));
  let totalBytes = 0;
  const visit = (node, ancestors) => {
    const frame = node.callFrame;
    const active = new Set(ancestors);
    for (const target of targets) {
      if (frame.functionName.includes(target)) {
        active.add(target);
      }
    }
    const bytes = node.selfSize;
    totalBytes += bytes;
    for (const target of active) {
      inclusive[target] += bytes;
    }
    if (bytes) {
      const key = `${frame.functionName}@${frame.url}:${frame.lineNumber + 1}`;
      sites.set(key, (sites.get(key) ?? 0) + bytes);
    }
    for (const child of node.children) {
      visit(child, active);
    }
  };
  visit(profile.head, new Set());
  return {
    totalBytes,
    inclusiveBytesByTarget: inclusive,
    sites: [...sites].toSorted((a, b) => b[1] - a[1]).slice(0, 100),
  };
}

function ownerCounts() {
  const lifetimes = globalThis[Symbol.for("openclaw.preparedPluginLifetimes")];
  const ephemeral = globalThis[Symbol.for("openclaw.ephemeralPreparedRegistryResources")];
  const resources = {};
  for (const name of process.getActiveResourcesInfo()) {
    resources[name] = (resources[name] ?? 0) + 1;
  }
  return {
    preparedPluginLifetimes: lifetimes?.active.size ?? null,
    preparedPluginRetirements: lifetimes?.retirements.size ?? null,
    ephemeralPreparedRegistryViews: ephemeral?.views.size ?? null,
    referencedResources: resources,
  };
}

if (isMainThread && process.send) {
  const inspector = new Session();
  inspector.connect();
  let mode;
  let cpu;
  let startedAt;
  let pending = Promise.resolve();
  async function observe(message) {
    const elapsedMs = startedAt === undefined ? 0 : performance.now() - startedAt;
    const used = cpu ? process.threadCpuUsage(cpu) : { user: 0, system: 0 };
    // Drop the prior event-loop turn's handles and collect twice before measuring.
    await nextTurn();
    await inspector.post("HeapProfiler.collectGarbage");
    await nextTurn();
    await inspector.post("HeapProfiler.collectGarbage");
    const spaces = getHeapSpaceStatistics();
    const memory = process.memoryUsage();
    const oldGenerationBytes = spaces
      .filter((space) => ["old_space", "large_object_space"].includes(space.space_name))
      .reduce((sum, space) => sum + space.space_used_size, 0);
    let sampled;
    if (message.action === "start") {
      if (mode !== undefined) {
        throw new Error("Retention measurement already started");
      }
      mode = message.mode;
      if (!["retained", "allocation", "timing"].includes(mode)) {
        throw new Error("Invalid retention mode");
      }
      if (mode !== "timing") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: mode === "allocation",
          includeObjectsCollectedByMinorGC: mode === "allocation",
        });
      }
    } else {
      if (mode === undefined) {
        throw new Error("Retention measurement has not started");
      }
      if (mode !== "timing") {
        const { profile } = await inspector.post("HeapProfiler.getSamplingProfile");
        sampled = summarizeProfile(profile);
      }
    }
    const observation = {
      mode,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      oldGenerationBytes,
      memory,
      spaces,
      hostLoad: loadavg(),
      sampled,
      ownerCounts: ownerCounts(),
      snapshotPath: message.snapshotPath ? writeHeapSnapshot(message.snapshotPath) : undefined,
    };
    cpu = process.threadCpuUsage();
    startedAt = performance.now();
    return observation;
  }
  process.on("message", (message) => {
    if (message?.channel !== "heap-rig-retention") {
      return;
    }
    pending = pending.then(async () => {
      try {
        const observation = await observe(message);
        process.send?.({ channel: message.channel, id: message.id, observation });
      } catch (error) {
        process.send?.({ channel: message.channel, id: message.id, error: String(error) });
      }
    });
  });
  process.channel?.unref();
}
