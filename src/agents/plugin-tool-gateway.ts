import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import {
  captureWorkspacePublicationProvider,
  isWorkspacePublicationGatewayMethod,
} from "../gateway/workspace-publication-binding.js";
import { captureExecRequestOwners } from "../infra/exec-request-context.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { resolveReplyRunForCurrentSessionId } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import type { OpenClawPluginToolOptions } from "./openclaw-tools.plugin-context.js";
import {
  canPrepareRepositoryWorkspace,
  canRefreshWorkspacePublicationBase,
  canReadWorkspaceArtifactSource,
} from "./sandbox/github-publication.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
} from "./tools/in-process-gateway.js";
import { handoffSessionTool } from "./tools/session-tool-handoff.js";
import { hasSessionControlAuthority } from "./tools/sessions-operator-authority.js";

/** Capture workspace/operation custody once; factories receive no raw caller or sandbox. */
export function preparePluginToolGatewayCapability(
  options: OpenClawPluginToolOptions | undefined,
  context: Pick<OpenClawPluginToolContext, "agentId" | "sessionKey">,
) {
  const sandbox = options?.sandbox;
  const clientCaps = Object.freeze([...(options?.clientCaps ?? [])]);
  let operation = options?.runId ? findSessionControllerOperationByRunId(options.runId) : undefined;
  if (options?.runId === undefined && options?.sessionId) {
    const current = resolveReplyRunForCurrentSessionId(options.sessionId);
    operation = current.kind === "one" ? current.operation : undefined;
  }
  const requestOwners = captureExecRequestOwners(options ?? {});
  const prepareAvailable = canPrepareRepositoryWorkspace(sandbox);
  const preparation = !prepareAvailable
    ? "unavailable"
    : sandbox.workspaceSource === "managed-worktree"
      ? "in-place"
      : "handoff";
  const workspace = Object.freeze({
    publicationAvailable: options?.githubPublicationAvailable,
    controlAvailable: hasSessionControlAuthority(options?.sessionControlAuthority),
    workspacePreparationAvailable: !sandbox,
    preparation,
    refreshBaseAvailable: canRefreshWorkspacePublicationBase(sandbox),
    evidenceAvailable: canReadWorkspaceArtifactSource(sandbox),
  });
  return (
    assertInvocationCurrent: () => void,
    pluginSignal?: AbortSignal,
    gatewayMethods: readonly string[] = [],
    pluginId?: string,
  ): NonNullable<OpenClawPluginToolContext["gateway"]> => {
    const ownedMethods = new Set(gatewayMethods);
    const hostContext = getInProcessGatewayToolContext();
    const assertWorkspaceProvider =
      pluginId && hostContext
        ? captureWorkspacePublicationProvider(hostContext, pluginId)
        : undefined;
    const assertOwnedMethod = (method: string) => {
      if (ownedMethods.has(method)) {
        return undefined;
      }
      if (isWorkspacePublicationGatewayMethod(method) && assertWorkspaceProvider) {
        assertWorkspaceProvider();
        return assertWorkspaceProvider;
      }
      throw new Error(
        "Plugin tools require an owned Gateway method or their installed workspace provider.",
      );
    };
    const signalFor = (signal?: AbortSignal) =>
      AbortSignal.any(
        [options?.abortSignal, pluginSignal, signal].filter((value): value is AbortSignal =>
          Boolean(value),
        ),
      );
    const currentCaller = () => {
      assertInvocationCurrent();
      pluginSignal?.throwIfAborted();
      const caller = getGatewayToolCallerIdentity();
      if (
        !caller?.agentId ||
        !caller.sessionKey ||
        (context.agentId !== undefined && caller.agentId !== context.agentId) ||
        (context.sessionKey !== undefined && caller.sessionKey !== context.sessionKey)
      ) {
        throw new Error("Plugin Gateway operations require their current admitted agent session.");
      }
      return caller;
    };
    return {
      get agentId() {
        return currentCaller().agentId;
      },
      get sessionKey() {
        return currentCaller().sessionKey;
      },
      clientCaps,
      workspace,
      idempotencyKey(toolCallId) {
        currentCaller();
        const turnId = getAgentToolAssistantTurnId();
        return turnId ? `${turnId}:${toolCallId}` : toolCallId;
      },
      async call<T>(
        method: string,
        params: Record<string, unknown>,
        request: { signal?: AbortSignal; timeoutMs?: number } = {},
      ) {
        const caller = currentCaller();
        const assertProvider = assertOwnedMethod(method);
        const signal = signalFor(request.signal);
        signal.throwIfAborted();
        return await withGatewayToolCallerIdentity(
          {
            ...caller,
            workspaceBaseRefreshSandbox: sandbox ?? undefined,
            workspaceEvidenceSandbox: sandbox ?? undefined,
          },
          () =>
            callInProcessGatewayTool<T>(method, params, {
              ...request,
              signal,
              sessionMutationCommitGuard: () => {
                assertInvocationCurrent();
                assertProvider?.();
              },
            }),
        );
      },
      async handoff(request) {
        const caller = currentCaller();
        const assertProvider = assertOwnedMethod(request.method);
        signalFor(request.signal).throwIfAborted();
        return await handoffSessionTool({
          ...request,
          sessionId: options?.sessionId,
          runId: options?.runId,
          operation,
          requestOwners,
          onYield: options?.onYield,
          senderIsOwner: options?.senderIsOwner,
          run: ({ assertCurrent, signal }) =>
            withGatewayToolCallerIdentity(
              {
                agentId: caller.agentId,
                sessionKey: caller.sessionKey,
                workspaceBaseRefreshSandbox: sandbox ?? undefined,
                workspacePrAdoptionSessionId: options?.sessionId,
              },
              () =>
                callAgentToolGatewayRequest({
                  method: request.method,
                  params: request.params,
                  sessionMutationCommitGuard: () => {
                    assertCurrent();
                    pluginSignal?.throwIfAborted();
                    assertProvider?.();
                  },
                  signal: pluginSignal ? AbortSignal.any([signal, pluginSignal]) : signal,
                  timeoutMs: null,
                }),
            ),
          formatResult(payload) {
            pluginSignal?.throwIfAborted();
            return request.formatResult(payload);
          },
        });
      },
    };
  };
}
