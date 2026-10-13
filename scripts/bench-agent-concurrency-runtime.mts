import { mock } from "node:test";
import type { SubagentRunMutation } from "../src/agents/subagents/registry/subagent-registry-mutation.types.js";
import type { SubagentRunMutationOptions } from "../src/agents/subagents/registry/subagent-registry-persistence.types.js";
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
      captureSubagentCompletionReply: async () => undefined,
    } satisfies Pick<
      typeof import("../src/agents/subagents/announce/subagent-announce.js"),
      "captureSubagentCompletionReply"
    >);
    replaceModule("../src/agents/subagents/announce/subagent-announce.requester-settle-wake.ts", {
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    } satisfies typeof import("../src/agents/subagents/announce/subagent-announce.requester-settle-wake.js"));
    const persistence =
      await import("../src/agents/subagents/registry/subagent-registry-persistence.js");
    if (mode === "memory") {
      const { bindSubagentRunRecord } =
        await import("../src/agents/subagents/registry/subagent-registry.store.codec.js");
      const { subagentRunRowVersion } =
        await import("../src/agents/subagents/registry/subagent-registry.store.row.js");
      const mutate = async <P extends SubagentRunMutation<unknown>>(
        runIds: readonly string[],
        plan: (rows: ReadonlyMap<string, SubagentRunRecord>) => P,
        options: SubagentRunMutationOptions<P> = {},
      ): Promise<P["value"]> => {
        if (options.commit) {
          throw new Error("Memory benchmark reached a native completion transaction");
        }
        return await persistence.mutateSubagentRuns(runIds, plan, {
          ...options,
          onPublished: (postimages, value) => {
            if (postimages.size > 0) {
              options.onPublished?.(postimages, value);
            }
          },
          commit: async (planned, _versions, authority) => {
            authority.assertCurrent();
            if (planned.terminalEvents?.length) {
              throw new Error("Memory benchmark attempted durable terminal signals");
            }
            const postimages = new Map(
              [...(planned.postimages ?? [])].map(
                ([runId, row]) => [runId, row ? structuredClone(row) : null] as const,
              ),
            );
            const versions = new Map(
              [...postimages].map(
                ([runId, row]) =>
                  [runId, row ? subagentRunRowVersion(bindSubagentRunRecord(row)) : null] as const,
              ),
            );
            return { value: planned.value, postimages, versions };
          },
        });
      };
      replaceModule("../src/agents/subagents/registry/subagent-registry-persistence.ts", {
        ...persistence,
        mutateSubagentRuns: mutate,
      } satisfies typeof persistence);
    }

    const gatewayRuntime = await import("../src/gateway/server-recovery-runtime-context.js");
    replaceModule("../src/gateway/server-recovery-runtime-context.ts", {
      ...gatewayRuntime,
      bindGatewayLifecycleRequest: () => request,
    } satisfies typeof gatewayRuntime);

    const completion =
      await import("../src/agents/subagents/registry/subagent-registry-lifecycle-completion.js");
    replaceModule("../src/agents/subagents/registry/subagent-registry-lifecycle-completion.ts", {
      ...completion,
      completeSubagentRunAttempt: async (context, params) =>
        completion.completeSubagentRunAttempt(context, {
          ...params,
          // These synthetic runs have no child session or transcript to update.
          suppressSessionEffects: true,
          completionSnapshot: { resultText: null, capturedAt: params.endedAt ?? Date.now() },
        }),
    } satisfies typeof completion);

    const config = await import("../src/config/runtime-snapshot.js");
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
