import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import type { McpAppRequesterIdentity, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getBeforeToolCallRequestMeta } from "./before-tool-call-request-meta.js";
import {
  createMcpClientElicitationHandler,
  runWithMcpElicitationHandler,
} from "./mcp-client-elicitation.js";
import {
  projectMcpCallToolResult,
  setMcpCodeModeGuestResultFromAgentResult,
} from "./mcp-content.js";
import { prepareMcpAppFormUpload } from "./mcp-form-resource-upload.js";
import { captureMcpFormRequester } from "./mcp-form-tool-approval.js";
import {
  buildMcpAppCanvasPayload,
  fetchMcpAppView,
  type McpAppFormOrigin,
} from "./mcp-ui-resource.js";
import type { AnyAgentTool } from "./tools/common.js";

type ToolExecuteFactory = (tool: McpCatalogTool) => AnyAgentTool["execute"];

type ExecuteFactoryParams = {
  runtime: SessionMcpRuntime;
  /** Unmerged catalog reference: matches the original materialize closure's server name checks. */
  catalog: McpToolCatalog;
  agentId?: string;
  appRequester?: McpAppRequesterIdentity;
  /** Live map reader: materialize reassigns allowedAppToolsByServer on policy reload. */
  readAllowedAppToolsByServer: () => Map<string, Set<string>> | undefined;
  /** Live reader: materialize assigns disposal only when dispose() begins. */
  readDisposal: () => Promise<void> | undefined;
};

/** createExecute is broken out of agent-bundle-mcp-materialize to respect the source line budget. */
export function createBundleMcpToolExecuteFactory(
  params: ExecuteFactoryParams,
): ToolExecuteFactory {
  const { runtime, catalog, readDisposal } = params;
  const allowedAppToolsByServer = () => params.readAllowedAppToolsByServer();
  return (tool) => async (toolCallId, originalInput, signal) =>
    runWithSessionMcpRequestSignal(signal, async () => {
      const appRequester =
        params.appRequester ?? runtime.appRequester ?? captureMcpFormRequester(runtime.sessionKey);
      if (!Object.hasOwn(catalog.servers, tool.serverName)) {
        const connect = runtime.requesterConnect?.createExecute(tool.serverName);
        if (connect) {
          return setMcpCodeModeGuestResultFromAgentResult(await connect(toolCallId, originalInput));
        }
      }
      runtime.markUsed();
      // Arguments pass through untouched, including any caller-supplied
      // `_meta`: hook-authored context rides the MCP request level only.
      const callMeta = getBeforeToolCallRequestMeta();
      const { serverName, toolName } = tool;
      const invoke = () =>
        callMeta
          ? runtime.callTool(serverName, toolName, originalInput, { _meta: callMeta })
          : runtime.callTool(serverName, toolName, originalInput);
      const result = await (runtime.sessionKey
        ? runWithMcpElicitationHandler(
            createMcpClientElicitationHandler({
              sessionKey: runtime.sessionKey,
              agentId: params.agentId,
              prepareResourceContext:
                runtime.isRequesterScopedServer?.(serverName) && !appRequester
                  ? undefined
                  : async (request) => {
                      if (!params.agentId || !runtime.sessionKey) {
                        throw new Error("MCP form origin has no session owner");
                      }
                      const { createMcpAppFormResourceContext } =
                        await import("../gateway/mcp-app-form-resources.js");
                      const assertCurrent = () => {
                        signal?.throwIfAborted();
                        request.signal.throwIfAborted();
                        if (readDisposal()) {
                          throw new Error("MCP form run has ended");
                        }
                      };
                      assertCurrent();
                      const origin: McpAppFormOrigin = {
                        runtime,
                        serverName,
                        agentId: params.agentId,
                        sessionKey: runtime.sessionKey,
                        requesterId: appRequester?.profileId,
                        assertCurrent,
                        /** Model-run forms retain their allowlist, then borrow current App approval for each preview. */
                        prepareToolCall: async (action) => {
                          const assertToolCallCurrent = () => {
                            origin.assertCurrent();
                            action.assertCurrent();
                            if (!allowedAppToolsByServer()?.get(serverName)?.has(action.toolName)) {
                              throw new Error(
                                "MCP form preview tool is not granted by the active run",
                              );
                            }
                          };
                          assertToolCallCurrent();
                          const { prepareModelCreatedAppToolCall } =
                            await import("../gateway/mcp-app-operations.js");
                          return await prepareModelCreatedAppToolCall(
                            {
                              runtime: origin.runtime,
                              view: {
                                serverName: origin.serverName,
                                sessionId: origin.runtime.sessionId,
                                agentId: origin.agentId,
                                requesterId: origin.requesterId,
                                allowedAppToolNames: allowedAppToolsByServer()?.get(serverName),
                              },
                            },
                            { ...action, assertCurrent: assertToolCallCurrent },
                          );
                        },
                      };
                      return await createMcpAppFormResourceContext({
                        snapshot: request.snapshot,
                        signal: request.signal,
                        origin,
                        uploadResources: await prepareMcpAppFormUpload(origin),
                      });
                    },
              assertCurrent: () => {
                signal?.throwIfAborted();
                if (readDisposal()) {
                  throw new Error("MCP run has ended");
                }
              },
            }),
            invoke,
          )
        : invoke());
      const scopedServer = runtime.isRequesterScopedServer?.(serverName) === true;
      const requesterId = appRequester?.profileId;
      const details: Record<string, unknown> = { mcpServer: serverName, mcpTool: toolName };
      // Transport sender ids are not Gateway profiles. Keep private channel
      // views suppressed until an identity owner supplies a mapped profile.
      if (runtime.mcpAppsEnabled && tool.uiResourceUri && (!scopedServer || requesterId)) {
        // Base semantics: an established restriction map grants an explicit empty
        // set when it lacks this server; only a missing map means "never bound".
        const appToolMap = allowedAppToolsByServer();
        const allowedAppToolNames = appToolMap
          ? (appToolMap.get(serverName) ?? new Set<string>())
          : undefined;
        const view = await fetchMcpAppView({
          runtime,
          agentId: params.agentId,
          requesterId,
          uploadResources:
            params.agentId && runtime.sessionKey
              ? await prepareMcpAppFormUpload({
                  runtime,
                  serverName,
                  agentId: params.agentId,
                  sessionKey: runtime.sessionKey,
                  requesterId,
                  assertCurrent: () => {
                    runtime.assertOwnerCurrent?.();
                  },
                })
              : undefined,
          serverName,
          toolName,
          uiResourceUri: tool.uiResourceUri,
          toolCallId,
          toolInput: originalInput,
          toolResult: result,
          ...(allowedAppToolNames ? { allowedAppToolNames } : {}),
        });
        if (view) {
          details.mcpAppPreview = buildMcpAppCanvasPayload({
            ...view,
            ...(runtime.sessionKey ? { originSessionKey: runtime.sessionKey } : {}),
            ...(result["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
          });
        }
      }
      return projectMcpCallToolResult(result, details);
    });
}
