import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { GatewayLifecycleRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { deleteGatewaySession } from "../../../gateway/server-methods/sessions-delete.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";

vi.mock("../../../gateway/server-methods/sessions-delete.js", () => ({
  deleteGatewaySession: async ({
    params,
    context,
    assertCurrent,
  }: Parameters<typeof deleteGatewaySession>[0]): ReturnType<typeof deleteGatewaySession> => {
    // Both deletion entry points share this host fixture's controlled completion.
    assertCurrent?.();
    await expectDefined(
      context.lifecycleRuntime,
      "fixture lifecycle runtime",
    ).dispatchSessionMethod("sessions.delete", params, { assertCurrent });
    assertCurrent?.();
    return { ok: true, result: { ok: true, key: params.key, deleted: true, archived: [] } };
  },
}));

export async function activateSubagentRegistryWithLifecycleRuntime(
  mod: SubagentRegistryHarness,
  lifecycleRuntime: GatewayLifecycleRuntime,
): Promise<void> {
  const gatewayContext = {
    lifecycleRuntime,
    trackExecution: trackAsyncWork,
    resolveGatewayContext: () => gatewayContext as never,
  };
  bindGatewayContextResolver(lifecycleRuntime, gatewayContext.resolveGatewayContext);
  await mod.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
}
