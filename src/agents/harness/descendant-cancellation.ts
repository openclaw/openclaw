import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import type { AgentHarness, AgentHarnessDescendantCancellationResult } from "./types.js";

type CancellationParams = Parameters<NonNullable<AgentHarness["withDescendantCancellation"]>>[0];

/** Capture the registered owners before parent cancellation can release its runtime scope. */
export async function withAgentHarnessDescendantCancellation<T>(
  params: CancellationParams,
  run: (cancel: () => Promise<AgentHarnessDescendantCancellationResult>) => Promise<T>,
): Promise<T> {
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  const owners =
    registry?.agentHarnesses.flatMap((registration) => {
      const prepare = registration.harness.withDescendantCancellation;
      if (!prepare) {
        return [];
      }
      const record = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
      const current =
        record || registration.pluginId === "core"
          ? capturePluginLifecycleAuthority(registry, record, {
              scopedRuntime: scoped === registry,
            })
          : undefined;
      return [{ registration, prepare, current }];
    }) ?? [];
  const cancellations: Array<() => Promise<AgentHarnessDescendantCancellationResult>> = [];
  const prepareNext = async (index: number): Promise<T> => {
    const owner = owners[index];
    if (!owner) {
      let called = false;
      return run(async () => {
        if (called) {
          throw new Error("Descendant cancellation was already consumed");
        }
        called = true;
        const results = await Promise.allSettled(cancellations.map((cancel) => cancel()));
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [...(result.value.errors ?? [])],
        );
        try {
          params.assertCurrent();
        } catch (error) {
          errors.push(error);
        }
        return results.reduce<AgentHarnessDescendantCancellationResult>(
          (total, result) => {
            if (result.status === "fulfilled") {
              total.killed += result.value.killed;
              total.cancelledRequesters.push(...result.value.cancelledRequesters);
            }
            return total;
          },
          { killed: 0, cancelledRequesters: [], ...(errors.length ? { errors } : {}) },
        );
      });
    }
    let active = true;
    const assertCurrent = () => {
      params.assertCurrent();
      if (
        !active ||
        !owner.current?.() ||
        (scoped && scopedRegistry() !== scoped) ||
        !registry?.agentHarnesses.includes(owner.registration) ||
        owner.registration.harness.withDescendantCancellation !== owner.prepare
      ) {
        throw new Error("Descendant cancellation harness owner changed");
      }
    };
    try {
      assertCurrent();
      const result = await owner.prepare({ ...params, assertCurrent }, async (cancel) => {
        assertCurrent();
        cancellations.push(async () => {
          assertCurrent();
          const count = await cancel();
          try {
            assertCurrent();
          } catch (error) {
            return { ...count, errors: [...(count.errors ?? []), error] };
          }
          return count;
        });
        return prepareNext(index + 1);
      });
      assertCurrent();
      return result;
    } finally {
      active = false;
    }
  };
  return prepareNext(0);
}
