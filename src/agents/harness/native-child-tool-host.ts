import { randomUUID } from "node:crypto";
import { inheritSessionMcpStoreOwner } from "../../config/sessions/session-mcp-store-admission.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import {
  bindGatewayContextResolver,
  captureGatewayContextResolver,
  getGatewayContextResolver,
} from "../../plugins/runtime/gateway-context-binding.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureAdmittedRunSourceForChild,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { captureAgentWorkspaceReadiness } from "../workspace-readiness.js";
import type {
  AgentHarnessHostCapabilityParams,
  AgentHarnessHostAttempt,
} from "./host-capability-internal.types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { captureHostToolPolicyConfigReader } from "./host-capability-workspace.js";
import {
  bindNativeChildToolSource,
  registerNativeChildToolIssuer,
  type NativeChildToolSource,
} from "./native-child-tool-bindings.js";

/** Bind only actual host-issued sources. Model admission or a copied handle is not a tool grant. */
function registerNativeChildToolHost(params: {
  parent: AgentHarnessHostCapabilities;
  attempt: AgentHarnessHostAttempt;
  source: NativeChildToolSource;
  readConfig?: () => NonNullable<AgentHarnessHostAttempt["config"]>;
  scope?: "turn" | "conversation";
}) {
  const { attempt, source, parent } = params;
  const config = attempt.config;
  const agentId = attempt.agentId;
  if (!config || !agentId || !attempt.sessionKey || !attempt.sessionId) {
    return;
  }
  const issuer = captureAdmittedRunSourceForChild(attempt.admittedRunContext);
  if (!issuer) {
    return;
  }
  const origin = getGatewayToolCallerIdentity();
  if (
    origin &&
    (origin.operationalRunInstance !== attempt.admittedRunContext.operationalRunInstance ||
      origin.workerTurnClaim ||
      origin.personalToolSelection ||
      origin.receiptAdmissions?.length)
  ) {
    // These additional authority bindings belong to another occurrence or cannot be delegated.
    return;
  }
  const requester = origin?.webchatMcpRequester;
  if (
    requester &&
    (requester.sessionId !== attempt.sessionId ||
      requester.requesterSenderId !== issuer.operator.profileId)
  ) {
    return;
  }
  requester?.assertCurrent();
  const assertToolAllowed = origin?.assertToolAllowed;
  const fullPermission = origin?.fullPermission === false ? false : undefined;
  const sourceSessionKey = attempt.sessionKey;
  const workspace = captureAgentWorkspaceReadiness(sourceSessionKey);
  const resolveGatewayContext = captureGatewayContextResolver(
    getGatewayContextResolver(attempt.admittedRunContext),
  );
  const configAtAdmission = params.readConfig?.();
  const registryAtAdmission = getPluginRegistryState()?.activeVersion;
  // Preserve the store witness for this requester's MCP connections only.
  const storeOwner = {};
  inheritSessionMcpStoreOwner(parent, storeOwner);
  bindNativeChildToolSource(source, parent, async (request, execute) => {
    const signal = source.signal
      ? AbortSignal.any([source.signal, request.signal])
      : request.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      source.assertCurrent();
      workspace?.assertCurrent();
      request.assertCurrent();
      assertToolAllowed?.(request.toolName);
      issuer.assertCurrent?.();
      if (
        (resolveGatewayContext && !resolveGatewayContext()) ||
        params.readConfig?.() !== configAtAdmission ||
        getPluginRegistryState()?.activeVersion !== registryAtAdmission
      ) {
        throw new Error("Native child tool source changed. Start a new parent turn.");
      }
    };
    assertCurrent();
    if (workspace) {
      await workspace.waitUntilReady();
      assertCurrent();
    }
    // Concurrent calls must not replace one another's operational admission.
    const runId = request.childRunId + ":tool:" + randomUUID();
    const admission = prepareAgentRunAdmission({
      cfg: config,
      facts: { runId, agentId, ingress: { kind: "subagent", boundary: "native-child.tool" } },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      operatorAuthority: issuer.operator,
      assertSourceCurrent: assertCurrent,
    });
    let closeHost: (() => void) | undefined;
    try {
      const admittedRunContext = await admission.admit("plugin-harness", "codex");
      bindGatewayContextResolver(admittedRunContext, resolveGatewayContext);
      inheritSessionMcpStoreOwner(storeOwner, admittedRunContext.operationalRunInstance);
      const owner = {
        agentId,
        sessionId: request.threadId,
        sessionKey: request.childRunId,
        runId,
        admittedRunContext,
      };
      // Never borrow a foreground run's client or caller from an event handler's async context.
      return await withoutGatewayToolCallerIdentity(() =>
        withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            context: resolveGatewayContext?.(),
            resolveGatewayContext,
          },
          async () => {
            const { createAgentHarnessHostCapabilities } = await import("./host-capability.js");
            const host = createAgentHarnessHostCapabilities({
              attempt: {
                ...owner,
                config,
                workspaceDir: attempt.workspaceDir,
                cwd: attempt.cwd,
                senderId: attempt.senderId,
                senderName: attempt.senderName,
                senderUsername: attempt.senderUsername,
                senderE164: attempt.senderE164,
                senderIsOwner: attempt.senderIsOwner,
                messageChannel: attempt.messageChannel,
                messageProvider: attempt.messageProvider,
                agentAccountId: attempt.agentAccountId,
                operatorProfileId: attempt.operatorProfileId,
                skillsSnapshot: attempt.skillsSnapshot,
                preparedModelRuntime: attempt.preparedModelRuntime,
                sandbox: attempt.sandbox,
                requireWorkspaceOnly: attempt.requireWorkspaceOnly,
                toolExecutionAllow: attempt.toolExecutionAllow,
                abortSignal: signal,
              },
              pluginId: "codex",
            });
            closeHost = host.close;
            host.setToolPolicyScope(params.scope);
            const caller = createAdmittedGatewayToolCallerIdentity({
              ...owner,
              requesterOrigin: attempt.requesterOrigin,
              receiptAuthority: assertCurrent,
              approvalSignals: [signal],
            });
            if (caller) {
              caller.fullPermission = fullPermission;
              caller.assertToolAllowed = assertToolAllowed;
              if (requester) {
                caller.webchatMcpRequester = {
                  sessionId: requester.sessionId,
                  requesterSenderId: issuer.operator.profileId,
                  connectionSessionKey: sourceSessionKey,
                  assertCurrent,
                };
              }
            }
            return await withGatewayToolCallerIdentity(caller, () =>
              host.runWithScope(() => execute(host.capabilities, runId)),
            );
          },
        ),
      );
    } finally {
      closeHost?.();
      admission.close();
    }
  });
}

export function registerNativeChildToolHostIssuer(
  parent: AgentHarnessHostCapabilities,
  params: AgentHarnessHostCapabilityParams,
  readScope: () => "turn" | "conversation" | undefined,
) {
  if (
    params.pluginId !== "codex" ||
    params.toolCalls === "deny" ||
    params.attempt.scheduledToolPolicy
  ) {
    return;
  }
  const readConfig = captureHostToolPolicyConfigReader(params.attempt)({
    config: params.attempt.config,
  });
  registerNativeChildToolIssuer(parent, (source) =>
    registerNativeChildToolHost({
      parent,
      source,
      attempt: params.attempt,
      readConfig,
      scope: readScope(),
    }),
  );
}
