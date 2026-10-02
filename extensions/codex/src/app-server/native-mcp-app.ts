import {
  prepareHarnessNativeMcpAppPreview,
  loadAgentHarnessMcpConfig,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type McpToolCatalog,
  type SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createHarnessMcpFormResourceContext,
  captureMcpClientElicitation,
  normalizeMcpCodexToolAnnotations,
  readMcpAppIcons,
  readMcpAppSettingsCapability,
  readMcpAppToolExtensions,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { parseCodexPluginMarketplaceId } from "../plugin-marketplace-discovery.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import { getCodexAppServerClientInstanceId, type CodexAppServerClient } from "./client.js";
import { readCodexMcpToolConnectorId, readCodexMcpToolUiVisibility } from "./mcp-tool-metadata.js";
import { requestPluginApprovalOutcome } from "./plugin-approval-roundtrip.js";
import type { ToolCallResult } from "./protocol-mcp.js";
import type { CodexMcpServerStatus, CodexThreadItem, JsonObject, JsonValue } from "./protocol.js";
import {
  captureCodexAppServerClientLifetime,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

const CODEX_APPS_MCP_SERVER = "codex_apps";
const toolCallMetadataSchema = z.record(z.string(), z.json());

function readMcpAppResourceUri(item: CodexThreadItem): string | undefined {
  const appContext = asOptionalRecord(item.appContext);
  const uri =
    normalizeOptionalString(appContext?.resourceUri) ??
    normalizeOptionalString(item.mcpAppResourceUri);
  return uri?.startsWith("ui://") ? uri : undefined;
}

function readMcpToolResult(item: CodexThreadItem): ToolCallResult | undefined {
  const result = asOptionalRecord(item.result);
  if (!result || !Array.isArray(result.content)) {
    return undefined;
  }
  const resultMeta = asOptionalRecord(result["_meta"]);
  return {
    content: result.content as JsonValue[],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent as JsonValue }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    // Codex serializes absent MCP result metadata as null. The MCP SDK accepts
    // only an object when `_meta` is present, so forwarding null makes Apps
    // discard the complete tool-result notification during schema validation.
    ...(resultMeta ? { _meta: resultMeta as JsonValue } : {}),
  };
}

function statusTools(status: CodexMcpServerStatus): Array<Record<string, unknown>> {
  return Object.entries(status.tools).map(([name, value]) =>
    Object.assign({}, asOptionalRecord(value) ?? {}, { name }),
  );
}

export function createNativeMcpRuntime(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "sessionId" | "sessionKey" | "workspaceDir" | "senderId" | "config" | "toolOverrides"
  >;
  originCallId: string;
  appRequester?: SessionMcpRuntime["appRequester"];
  connectorId?: string;
  assertCurrent?: () => void;
}): SessionMcpRuntime {
  // App interactions must stay on the thread-owned Codex MCP connection; opening
  // a second client here would lose server-local state between render and click.
  let catalog: McpToolCatalog | null = null;
  let statuses: CodexMcpServerStatus[] | undefined;
  const createdAt = Date.now();
  let localFileOwner: (() => void) | undefined;
  try {
    localFileOwner = captureCodexAppServerClientLifetime(params.client, "native-process");
  } catch {
    /* Remote transports do not support host-local uploads. */
  }
  let localServerNames: Set<string> | undefined;
  const loadStatuses = async () => {
    params.assertCurrent?.();
    if (statuses) {
      return statuses;
    }
    const loaded: CodexMcpServerStatus[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      params.assertCurrent?.();
      const response = await params.client.request(
        "mcpServerStatus/list",
        {
          threadId: params.threadId,
          detail: "full",
          ...(cursor ? { cursor } : {}),
        },
        { assertCurrent: params.assertCurrent },
      );
      params.assertCurrent?.();
      loaded.push(...response.data);
      if (!response.nextCursor) {
        statuses = loaded;
        return statuses;
      }
      if (cursors.has(response.nextCursor)) {
        throw new Error("Native MCP status cursor repeated");
      }
      cursor = response.nextCursor;
      cursors.add(cursor);
    }
    throw new Error("Native MCP status exceeded the page limit");
  };
  const getCatalog = async (): Promise<McpToolCatalog> => {
    if (catalog) {
      return catalog;
    }
    const loaded = await loadStatuses();
    if (localFileOwner && !localServerNames) {
      const configured = await loadAgentHarnessMcpConfig({
        workspaceDir: params.attempt.workspaceDir,
        cfg: params.attempt.config,
        toolOverrides: params.attempt.toolOverrides,
      });
      params.assertCurrent?.();
      localFileOwner();
      localServerNames = new Set(
        Object.entries(configured.config.mcpServers)
          .filter(
            ([, server]) =>
              (normalizeLowercaseStringOrEmpty(server.transport) || "stdio") === "stdio" &&
              typeof server.command === "string",
          )
          .map(([name]) => name),
      );
    }
    catalog = {
      version: 1,
      generatedAt: Date.now(),
      servers: Object.fromEntries(
        loaded.map((status) => [
          status.name,
          {
            serverName: status.name,
            launchSummary: "Codex native MCP connection",
            ...(status.pluginId
              ? {
                  pluginId:
                    parseCodexPluginMarketplaceId(status.pluginId)?.pluginName ?? status.pluginId,
                  marketplace: parseCodexPluginMarketplaceId(status.pluginId)?.marketplaceName,
                }
              : {}),
            title: status.serverInfo?.title ?? undefined,
            icons: readMcpAppIcons(status.serverInfo?.icons),
            settings: readMcpAppSettingsCapability(status.serverCapabilities),
            toolCount: Object.keys(status.tools).length,
          },
        ]),
      ),
      tools: loaded.flatMap((status) =>
        statusTools(status).map((tool) => {
          const uiVisibility = readCodexMcpToolUiVisibility(tool);
          return Object.assign(
            {
              serverName: status.name,
              safeServerName: status.name,
              toolName: String(tool.name),
              title:
                normalizeOptionalString(tool.title) ??
                normalizeOptionalString(asOptionalRecord(tool.annotations)?.title),
              appExtensions: readMcpAppToolExtensions(tool),
              codexAnnotations: normalizeMcpCodexToolAnnotations(tool.annotations),
              uiResourceUri: normalizeOptionalString(
                asOptionalRecord(asOptionalRecord(tool._meta)?.ui)?.resourceUri,
              ),
              inputSchema: (asOptionalRecord(tool.inputSchema) ?? { type: "object" }) as never,
              fallbackDescription: normalizeOptionalString(tool.description) ?? String(tool.name),
            },
            uiVisibility ? { uiVisibility } : {},
          );
        }),
      ),
    };
    return catalog;
  };
  const runtime: SessionMcpRuntime = {
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    workspaceDir: params.attempt.workspaceDir,
    configFingerprint: `${getCodexAppServerClientInstanceId(params.client)}:${params.threadId}`,
    mcpAppsEnabled: true,
    ...(params.appRequester ? { appRequester: params.appRequester } : {}),
    assertOwnerCurrent: params.assertCurrent,
    canReadLocalFiles: (serverName) => {
      params.assertCurrent?.();
      if (!localFileOwner || !localServerNames?.has(serverName)) {
        return false;
      }
      localFileOwner();
      return true;
    },
    createdAt,
    lastUsedAt: createdAt,
    // Each live view outlives the turn, so retain the shared app-server client
    // until the view store releases its lease.
    acquireLease: () => {
      params.assertCurrent?.();
      const releaseClient = retainSharedCodexAppServerClientIfCurrent(params.client);
      if (!releaseClient) {
        throw new Error("Native MCP App client is no longer current");
      }
      const unprotect = protectCodexAppServerLiveThread(params.client, params.threadId);
      return () => {
        unprotect();
        releaseClient();
      };
    },
    getCatalog,
    peekCatalog: () => catalog,
    markUsed: () => {
      runtime.lastUsedAt = Date.now();
    },
    callTool: async (serverName, toolName, input, options) => {
      const assertCurrent = () => {
        params.assertCurrent?.();
        options?.assertCurrent?.();
      };
      assertCurrent();
      const elicitation = captureMcpClientElicitation();
      const call = async () =>
        (await params.client.request(
          "mcpServer/tool/call",
          {
            threadId: params.threadId,
            server: serverName,
            tool: toolName,
            arguments: (asOptionalRecord(input) ?? {}) as JsonObject,
            ...(options?._meta ? { _meta: toolCallMetadataSchema.parse(options._meta) } : {}),
          },
          // The client also checks authority after overload backoff, before
          // each retry write; cancellation alone cannot detect policy changes.
          { signal: elicitation?.signal, assertCurrent },
        )) as never;
      if (!elicitation) {
        return await call();
      }
      return await getCodexAppServerTurnRouter(params.client).withMcpToolCall(
        {
          threadId: params.threadId,
          serverName,
          signal: elicitation.signal,
          onRequest: async (request, _scope, signal) => {
            assertCurrent();
            const elicitationInput = asOptionalRecord(request.params);
            if (!elicitationInput) {
              throw new Error("Invalid native MCP elicitation");
            }
            const rich =
              elicitationInput.mode === "openai/form" || elicitationInput.mode === "openaiForm";
            const result = await elicitation.handle({
              method: rich ? "openai/elicitation/create" : "elicitation/create",
              requestId: request.id,
              params: elicitationInput,
              signal,
            });
            assertCurrent();
            return z.json().parse(result);
          },
        },
        call,
      );
    },
    listTools: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { tools: status ? statusTools(status) : [] } as never;
    },
    readResource: async (serverName, uri, options) => {
      params.assertCurrent?.();
      if (options?._meta && Object.keys(options._meta).length > 0) {
        throw new Error(
          "This Codex connection does not support metadata-selected remote resource representations",
        );
      }
      // Codex scopes and echoes originCallId only for its shared codex_apps server.
      // Ordinary MCP servers intentionally return no origin correlation.
      const isCodexAppsServer = serverName === CODEX_APPS_MCP_SERVER;
      const response = await params.client.request(
        "mcpServer/resource/read",
        {
          threadId: params.threadId,
          ...(isCodexAppsServer ? { originCallId: params.originCallId } : {}),
          server: serverName,
          uri,
          ...(params.connectorId ? { connectorId: params.connectorId } : {}),
        },
        { assertCurrent: params.assertCurrent },
      );
      if (isCodexAppsServer && response.originCallId !== params.originCallId) {
        throw new Error(
          `Codex MCP resource response originCallId mismatch: expected ${params.originCallId}, received ${response.originCallId}`,
        );
      }
      return response;
    },
    listResources: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { resources: status?.resources ?? [] };
    },
    listResourceTemplates: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { resourceTemplates: status?.resourceTemplates ?? [] } as never;
    },
    // This facade owns no MCP transport. The retained app-server client owns
    // process cleanup, including refusal to retire while another view holds it.
    joinCleanup: async () => {},
    dispose: async () => {},
  };
  return runtime;
}

export function createCodexNativeMcpAppResultDetailsPreparer(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): ((item: CodexThreadItem) => Promise<unknown>) | undefined {
  if (params.attempt.config?.mcp?.apps?.enabled !== true) {
    return undefined;
  }
  return async (item) => {
    const serverName = normalizeOptionalString(item.server);
    const toolName = normalizeOptionalString(item.tool);
    const uiResourceUri = readMcpAppResourceUri(item);
    const connectorId = normalizeOptionalString(asOptionalRecord(item.appContext)?.connectorId);
    const toolResult = readMcpToolResult(item);
    if (!serverName || !toolName || !uiResourceUri || !toolResult) {
      return undefined;
    }
    if (serverName === CODEX_APPS_MCP_SERVER && !connectorId) {
      return undefined;
    }
    const runtime = createNativeMcpRuntime({
      ...params,
      originCallId: item.id,
      ...(connectorId ? { connectorId } : {}),
    });
    const tools = (await runtime.listTools?.(serverName))?.tools ?? [];
    const allowedAppToolNames = new Set(
      tools
        .filter((tool) => {
          const uiVisibility = readCodexMcpToolUiVisibility(tool);
          return (
            (uiVisibility === undefined || uiVisibility.includes("app")) &&
            (serverName !== CODEX_APPS_MCP_SERVER ||
              readCodexMcpToolConnectorId(tool) === connectorId)
          );
        })
        .map((tool) => tool.name),
    );
    if (!allowedAppToolNames.has(toolName)) {
      return undefined;
    }
    await runtime.getCatalog();
    return await prepareHarnessNativeMcpAppPreview({
      runtime,
      agentId: params.attempt.agentId,
      serverName,
      toolName,
      uiResourceUri,
      toolCallId: item.id,
      toolInput: item.arguments ?? {},
      toolResult: toolResult as never,
      allowedAppToolNames,
      ...(toolResult["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
    });
  };
}

/** The per-turn projector, not a client-supplied resource id, selects the native origin. */
export async function prepareCodexNativeMcpFormResourceContext(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
  request: { requestId: string | number; snapshot: Record<string, unknown>; signal: AbortSignal };
  origin: { id: string; server: string; tool: string };
  assertCurrent: () => void;
}) {
  const assertCurrent = () => {
    params.assertCurrent();
    params.request.signal.throwIfAborted();
    params.attempt.hostCapabilities.assertActive();
  };
  assertCurrent();
  const initial = createNativeMcpRuntime({
    client: params.client,
    threadId: params.threadId,
    attempt: params.attempt,
    originCallId: params.origin.id,
    assertCurrent,
  });
  const tools = (await initial.listTools?.(params.origin.server))?.tools ?? [];
  assertCurrent();
  const source = tools.find((tool) => tool.name === params.origin.tool);
  if (!source) {
    throw new Error("Native MCP form origin is no longer listed");
  }
  const connectorId = readCodexMcpToolConnectorId(source);
  if (params.origin.server === CODEX_APPS_MCP_SERVER && !connectorId) {
    throw new Error("Native MCP form connector is unavailable");
  }
  const runtime = createNativeMcpRuntime({
    client: params.client,
    threadId: params.threadId,
    attempt: params.attempt,
    originCallId: params.origin.id,
    connectorId,
    assertCurrent,
  });
  const { agentId, sessionKey } = params.attempt;
  if (!agentId || !sessionKey) {
    throw new Error("Native MCP form origin has no session owner");
  }
  await runtime.getCatalog();
  assertCurrent();
  return await createHarnessMcpFormResourceContext({
    version: 1,
    requestId: params.request.requestId,
    snapshot: params.request.snapshot,
    signal: params.request.signal,
    origin: {
      runtime,
      serverName: params.origin.server,
      agentId,
      sessionKey,
      requesterId: runtime.appRequester?.profileId,
      assertCurrent,
      prepareToolCall: async (request) => {
        assertCurrent();
        request.assertCurrent();
        const target = tools.find((tool) => tool.name === request.toolName);
        if (
          !target ||
          params.attempt.toolOverrides?.mcpServers?.[params.origin.server] === false ||
          params.attempt.toolOverrides?.mcpToolsDeny?.[params.origin.server]?.includes(
            request.toolName,
          ) ||
          readCodexMcpToolUiVisibility(target)?.includes("app") === false ||
          (params.origin.server === CODEX_APPS_MCP_SERVER &&
            readCodexMcpToolConnectorId(target) !== connectorId)
        ) {
          throw new Error("Native form preview tool is not authorized");
        }
        const server = params.attempt.config?.mcp?.servers?.[params.origin.server];
        if (
          requiresMcpCodexToolApproval({
            mode: server
              ? resolveProjectedMcpCodexToolApprovalMode(params.origin.server, server)
              : "prompt",
            fullPermission: params.attempt.permissionMode === "full",
            annotations: normalizeMcpCodexToolAnnotations(target.annotations),
          })
        ) {
          const description = JSON.stringify({
            server: params.origin.server,
            tool: request.toolName,
            arguments: request.input,
          });
          if (description.length > 512) {
            throw new Error("Native form preview arguments exceed the approval display limit");
          }
          const outcome = await requestPluginApprovalOutcome({
            hostCapabilities: params.attempt.hostCapabilities,
            signal: request.signal ?? params.request.signal,
            title: "Run MCP form preview?",
            description,
            toolName: request.toolName,
            allowedDecisions: ["allow-once", "deny"],
          });
          if (outcome !== "approved-once") {
            throw new Error("Native MCP form preview was not approved");
          }
        }
        assertCurrent();
        request.assertCurrent();
      },
    },
  });
}
