import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
// Keep static: compiled-worker preparation belongs at collection, not in a hook or test deadline.
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createAgentHarnessCompletionScope } from "../agent-harness-completion-scope.js";
import type { HostCapabilityOwner } from "./host-capability-owner.types.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

export type AdmittedHostCapabilityTestFixture<Version extends 1 | 2 = 1 | 2> = Readonly<{
  admittedRunContext: AdmittedRunContext;
  hostCapabilities: HostCapabilityOwner<Version>["capabilities"];
  agentHarnessCompletionScope?: ReturnType<typeof createAgentHarnessCompletionScope>;
  closeHost: () => void;
  closeAdmission: () => void;
  runWithGatewayScope: <T>(run: () => T) => T;
  closeGateway: () => void;
}>;

export type HostCapabilityTestOptions = {
  hostCapabilityVersion?: 1 | 2;
  nativeModelPolicySupport?: "exact";
  toolCalls?: "deny";
  gatewayContext?: true;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: HostCapabilityTestOptions & { hostCapabilityVersion: 2 },
): Promise<AdmittedHostCapabilityTestFixture<2>>;
export function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options?: HostCapabilityTestOptions & { hostCapabilityVersion?: 1 },
): Promise<AdmittedHostCapabilityTestFixture<1>>;
export function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options?: HostCapabilityTestOptions,
): Promise<AdmittedHostCapabilityTestFixture>;
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: HostCapabilityTestOptions = {},
): Promise<AdmittedHostCapabilityTestFixture> {
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
    operatorAuthority: options.operatorAuthority,
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  if (resolveGatewayContext) {
    const { bindGatewayContextResolver } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    bindGatewayContextResolver(admittedRunContext, resolveGatewayContext);
  }
  const host = runWithGatewayScope(() =>
    createAgentHarnessHostCapabilities({
      version: options.hostCapabilityVersion,
      attempt: { ...attempt, admittedRunContext },
      pluginId: "codex",
      nativeModelPolicySupport: options.nativeModelPolicySupport,
      toolCalls: options.toolCalls,
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
