import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import type { McpAppRequesterIdentity } from "./agent-bundle-mcp-types.js";
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
  mcpAppsEnabled: boolean;
  /** Live map reader: materialize reassigns allowedAppToolsByServer on policy reload. */
  readAllowedAppToolsByServer: () => Map<string, Set<string>> | undefined;
  disposal: Promise<void> | undefined;
  isRequesterScopedServer: SessionMcpRuntime["isRequesterScopedServer"];
};

/** createExecute is broken out of agent-bundle-mcp-materialize to respect the source line budget. */
export function createBundleMcpToolExecuteFactory(
  params: ExecuteFactoryParams,
): ToolExecuteFactory {
  const { runtime, catalog, agentId, disposal } = params;
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
      let { input, callMeta } = hoistHookMeta(originalInput);
      const { serverName, toolName } = tool;
      const invoke = () =>
        callMeta
          ? runtime.callTool(serverName, toolName, input, { _meta: callMeta })
          : runtime.callTool(serverName, toolName, input);
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
                        if (disposal) {
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
                if (disposal) {
                  throw new Error("MCP run has ended");
                }
              },
            }),
            invoke,
          )
        : invoke());
      const agentResult = projectMcpCallToolResult(result, {
        mcpServer: serverName,
        mcpTool: toolName,
      });
      const scopedServer = runtime.isRequesterScopedServer?.(serverName) === true;
      const requesterId = appRequester?.profileId;
      // Transport sender ids are not Gateway profiles. Keep private channel
      // views suppressed until an identity owner supplies a mapped profile.
      if (runtime.mcpAppsEnabled && tool.uiResourceUri && (!scopedServer || requesterId)) {
        const allowedAppToolNames = allowedAppToolsByServer()?.get(serverName)
          ? (allowedAppToolsByServer()?.get(serverName) ?? new Set<string>())
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
          toolInput: input,
          toolResult: result,
          ...(allowedAppToolNames ? { allowedAppToolNames } : {}),
        });
        if (view) {
          (agentResult.details as Record<string, unknown>).mcpAppPreview = buildMcpAppCanvasPayload(
            {
              ...view,
              ...(runtime.sessionKey ? { originSessionKey: runtime.sessionKey } : {}),
              ...(result["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
            },
          );
        }
      }
      return agentResult;
    });
}

/** Hoists a hook-stamped _meta beside arguments so the MCP server can read it at the protocol level. */
function hoistHookMeta(input: unknown): {
  input: unknown;
  callMeta: Record<string, unknown> | undefined;
} {
  if (!isRecord(input) || !isRecord(input._meta)) {
    return { input, callMeta: undefined };
  }
  const callMeta = input._meta as Record<string, unknown>;
  delete input._meta;
  return { input, callMeta };
}
