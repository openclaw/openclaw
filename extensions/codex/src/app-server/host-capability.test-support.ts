import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type ToolsFactory = typeof createOpenClawCodingTools;
type HostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];
const toolFactories = new WeakMap<object, ToolsFactory | undefined>();

export function setCodexTestToolFactory(
  params: Pick<EmbeddedRunAttemptParams, "hostCapabilities">,
  factory: ToolsFactory,
): void {
  if (!toolFactories.has(params.hostCapabilities)) {
    throw new Error(
      "Synthetic tools require a lightweight test host; keep real host identity intact.",
    );
  }
  toolFactories.set(params.hostCapabilities, factory);
  toolFactories.set(params, factory);
}

export function getCodexTestToolFactory(
  params: Pick<EmbeddedRunAttemptParams, "hostCapabilities">,
): ToolsFactory | undefined {
  return toolFactories.get(params) ?? toolFactories.get(params.hostCapabilities);
}

/** Minimal host authority for tests that do not exercise host policy or approvals. */
export function createCodexTestHostCapabilities(
  overrides: Partial<Omit<HostCapabilities, "createToolSurfaceAsync">> = {},
): HostCapabilities {
  const host: HostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    retainSourceAuthority: () => undefined,
    bindModelExecution: () => ({
      signal: new AbortController().signal,
      assertCurrent: () => host.assertActive(),
      release: () => {},
    }),
    bindToolSurface: (tools) => tools,
    // Synthetic factories are not core producers. Real core projection tests
    // must use createAdmittedHostCapabilityTestFixture instead.
    readCoreToolDeclarations: () => [],
    createToolSurfaceAsync: async (options, bindingOptions) =>
      host.bindToolSurface(
        (toolFactories.get(host) ?? createOpenClawCodingTools)(options),
        bindingOptions,
      ),
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
    prepareContextMedia: async () => ({ images: [] }),
    ...overrides,
  });
  toolFactories.set(host, undefined);
  return host;
}

export function createHarnessHostCapabilities(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams["hostCapabilities"] {
  return createCodexTestHostCapabilities({
    runBeforeToolCall: async ({ nativeOperation: _nativeOperation, approvalMode, ...request }) =>
      await runBeforeToolCallHook({
        ...request,
        approvalMode: approvalMode === "defer" ? "defer" : "request",
        ctx: Object.freeze({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.config ? { config: params.config } : {}),
          ...(params.workspaceDir
            ? { cwd: params.workspaceDir, workspaceDir: params.workspaceDir }
            : {}),
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          runId: params.runId,
          trigger: params.trigger,
          approvalReviewerDeviceId: params.approvalReviewerDeviceId,
          turnSourceChannel: params.messageChannel ?? params.messageProvider,
          turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
          turnSourceAccountId: params.agentAccountId,
          turnSourceThreadId: params.currentThreadTs,
        }),
      }),
  });
}
