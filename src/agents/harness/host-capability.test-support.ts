import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type { createAgentHarnessCompletionScope } from "../agent-harness-completion-scope.js";
import type { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

type AdmittedHostCapabilityTestFixture = Readonly<{
  admittedRunContext: AdmittedRunContext;
  hostCapabilities: ReturnType<typeof createAgentHarnessHostCapabilities>["capabilities"];
  agentHarnessCompletionScope?: ReturnType<typeof createAgentHarnessCompletionScope>;
  closeHost: () => void;
  closeAdmission: () => void;
  runWithGatewayScope: <T>(run: () => T) => T;
  closeGateway: () => void;
}>;

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: { nativeModelPolicySupport?: "exact"; gatewayContext?: true } = {},
): Promise<AdmittedHostCapabilityTestFixture> {
  const { createAgentHarnessCompletionScope } =
    await import("../agent-harness-completion-scope.js");
  const { createOperationalRunInstanceRef, prepareAgentRunAdmission } =
    await import("../admitted-run-context.js");
  const { createAgentHarnessHostCapabilities } = await import("./host-capability.js");
  let resolveGatewayContext: GatewayContextResolver | undefined;
  let runWithGatewayScope = <T>(run: () => T): T => run();
  let closeGateway = () => {};
  if (options.gatewayContext) {
    const { createContext } =
      await import("../../gateway/server-plugin-in-process-dispatch.test-support.js");
    const { getGatewayContextLifetime, withPluginRuntimeGatewayRequestScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const context = createContext();
    const resolver = () => context;
    context.resolveGatewayContext = resolver;
    context.getRuntimeConfig = () => attempt.config ?? {};
    resolveGatewayContext = resolver;
    const lifetime = getGatewayContextLifetime(resolver);
    runWithGatewayScope = <T>(run: () => T): T => {
      lifetime.signal.throwIfAborted();
      return withPluginRuntimeGatewayRequestScope(
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
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  if (resolveGatewayContext) {
    const { bindGatewayContextResolver } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    bindGatewayContextResolver(admittedRunContext, resolveGatewayContext);
  }
  const host = runWithGatewayScope(() =>
    createAgentHarnessHostCapabilities({
      attempt: { ...attempt, admittedRunContext },
      pluginId: "codex",
      nativeModelPolicySupport: options.nativeModelPolicySupport,
    }),
  );
  return {
    admittedRunContext,
    hostCapabilities: host.capabilities,
    ...(attempt.sessionKey
      ? {
          agentHarnessCompletionScope: createAgentHarnessCompletionScope({
            requesterSessionKey: attempt.sessionKey,
            requesterAgentId: attempt.agentId ?? "main",
            gatewayContextResolver: resolveGatewayContext,
          }),
        }
      : {}),
    closeHost: host.close,
    closeAdmission: admission.close,
    runWithGatewayScope,
    closeGateway,
  };
}
