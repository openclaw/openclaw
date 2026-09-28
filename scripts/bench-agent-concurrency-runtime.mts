import { mock } from "node:test";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { callGateway } from "../src/gateway/call.js";

/** Install before the worker imports the registry; keep these bindings across its samples. */
export async function installBenchmarkRegistryRuntime(mode: "memory" | "durable") {
  const handles: Array<{ restore(): void }> = [];
  const replaceModule = (specifier: string, namedExports: object) => {
    handles.push(mock.module(new URL(specifier, import.meta.url), { namedExports }));
  };
  let closed = false;
  let clearConfig: (() => void) | undefined;
  let request: typeof callGateway = async () => {
    throw new Error("Benchmark Gateway wait barrier is not installed");
  };
  let runs: Map<string, SubagentRunRecord>;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      clearConfig?.();
    } finally {
      for (const handle of handles.toReversed()) {
        handle.restore();
      }
    }
  };

  try {
    replaceModule("../src/agents/subagents/announce/subagent-announce.ts", {
      captureSubagentCompletionReply: async (childSessionKey) => {
        const entry = [...runs.values()].find(
          (candidate) => candidate.childSessionKey === childSessionKey,
        );
        if (entry) {
          // Suppression starts at capture, after completion has claimed the row.
          entry.execution.suppressSessionEffects = true;
        }
        return undefined;
      },
    } satisfies Pick<
      typeof import("../src/agents/subagents/announce/subagent-announce.js"),
      "captureSubagentCompletionReply"
    >);
    replaceModule("../src/agents/subagents/announce/subagent-announce.requester-settle-wake.ts", {
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    } satisfies typeof import("../src/agents/subagents/announce/subagent-announce.requester-settle-wake.js"));
    if (mode === "memory") {
      const sqlite =
        await import("../src/agents/subagents/registry/subagent-registry.store.sqlite.js");
      replaceModule("../src/agents/subagents/registry/subagent-registry.store.sqlite.ts", {
        ...sqlite,
        saveSubagentRegistryToSqlite: () => {},
        saveSubagentRegistryChangesToSqlite: () => {},
      } satisfies typeof sqlite);
    }

    const gatewayRuntime = await import("../src/gateway/server-recovery-runtime-context.js");
    replaceModule("../src/gateway/server-recovery-runtime-context.ts", {
      ...gatewayRuntime,
      bindGatewayLifecycleRequest: () => request,
    } satisfies typeof gatewayRuntime);

    const [{ subagentRuns }, config] = await Promise.all([
      import("../src/agents/subagents/registry/subagent-registry-memory.js"),
      import("../src/config/runtime-snapshot.js"),
    ]);
    runs = subagentRuns;
    clearConfig = config.clearRuntimeConfigSnapshot;
    config.setRuntimeConfigSnapshot({});
    return {
      setCallGateway(call: typeof callGateway) {
        if (closed) {
          throw new Error("Benchmark registry runtime is closed");
        }
        request = call;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
