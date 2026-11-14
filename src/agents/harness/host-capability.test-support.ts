import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
// Keep static: compiled-worker preparation belongs at collection, not in a hook or test deadline.
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createAgentHarnessCompletionScope } from "../agent-harness-completion-scope.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

export const harnessHostAdmissionsForTest = new WeakMap<
  ReturnType<typeof createAgentHarnessHostCapabilities>["capabilities"],
  { admittedRunContext: AdmittedRunContext; close: () => void }
>();

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: {
    nativeModelPolicySupport?: "exact";
    toolCalls?: "deny";
    gatewayContext?: true;
    operatorAuthority?: AdmittedRunOperatorAuthority;
  } = {},
) {
  let resolveGatewayContext: GatewayContextResolver | undefined;
  let bindGateway: ((context: AdmittedRunContext) => void) | undefined;
  let runWithGatewayScope = <T>(run: () => T): T => run();
  let closeGateway = () => {};
  if (options.gatewayContext) {
    const { createContext } =
      await import("../../gateway/server-plugin-in-process-dispatch.test-support.js");
    const gateway = await import("../../plugins/runtime/gateway-request-scope.js");
    const context = createContext([], () => attempt.config ?? {});
    const resolver = () => context;
    context.resolveGatewayContext = resolver;
    resolveGatewayContext = resolver;
    bindGateway = (admitted) => gateway.bindGatewayContextResolver(admitted, resolver);
    const lifetime = gateway.getGatewayContextLifetime(resolver);
    runWithGatewayScope = <T>(run: () => T): T => {
      lifetime.signal.throwIfAborted();
      return gateway.withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
        run,
      );
    };
    closeGateway = () => lifetime.abort(new Error("Test Gateway closed"));
  }
  const admission = prepareAgentRunAdmission({
    cfg: attempt.config ?? {},
    facts: {
      runId: attempt.runId,
      agentId: attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    operatorAuthority: options.operatorAuthority,
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  bindGateway?.(admittedRunContext);
  const hostAttempt = { ...attempt, admittedRunContext };
  const host = runWithGatewayScope(() =>
    createAgentHarnessHostCapabilities({
      attempt: hostAttempt,
      pluginId: "codex",
      nativeModelPolicySupport: options.nativeModelPolicySupport,
      toolCalls: options.toolCalls,
    }),
  );
  harnessHostAdmissionsForTest.set(host.capabilities, {
    admittedRunContext,
    close: admission.close,
  });
  return {
    attempt: hostAttempt,
    admittedRunContext,
    hostCapabilities: host.capabilities,
    ...(attempt.sessionKey && {
      agentHarnessCompletionScope: createAgentHarnessCompletionScope({
        requesterSessionKey: attempt.sessionKey,
        requesterAgentId: attempt.agentId ?? "main",
        gatewayContextResolver: resolveGatewayContext,
      }),
    }),
    closeHost: host.close,
    closeAdmission: admission.close,
    runWithGatewayScope,
    closeGateway,
  };
}
