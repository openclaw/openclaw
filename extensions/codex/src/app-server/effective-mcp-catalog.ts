import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import {
  assignMcpCatalogSafeServerNames,
  type McpToolCatalog,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { projectCodexMcpServerMetadata, projectCodexMcpToolMetadata } from "./mcp-tool-metadata.js";
import type { CodexMcpServerStatus } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;
type AgentHarnessMcpCatalogParams = Parameters<NonNullable<AgentHarness["loadMcpToolCatalog"]>>[0];

function catalogTool(params: {
  serverName: string;
  safeServerName: string;
  toolName: string;
  raw?: unknown;
  deniedBySession?: true;
}): McpToolCatalog["tools"][number] {
  const raw = asOptionalRecord(params.raw);
  const description = normalizeOptionalString(raw?.description);
  const { title, ...metadata } = projectCodexMcpToolMetadata(params.toolName, raw);
  const ui = asOptionalRecord(asOptionalRecord(raw?._meta)?.ui);
  return {
    serverName: params.serverName,
    safeServerName: params.safeServerName,
    toolName: params.toolName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    inputSchema: (asOptionalRecord(raw?.inputSchema) ?? { type: "object" }) as never,
    ...metadata,
    ...(Array.isArray(ui?.visibility)
      ? {
          uiVisibility: ui.visibility.filter(
            (value): value is "app" | "model" => value === "app" || value === "model",
          ),
        }
      : {}),
    ...(params.deniedBySession ? { deniedBySession: true } : {}),
  };
}

function buildCodexEffectiveMcpCatalog(
  statuses: readonly CodexMcpServerStatus[],
  toolOverrides?: AgentHarnessMcpCatalogParams["toolOverrides"],
): McpToolCatalog {
  const orderedStatuses = [
    ...new Map(statuses.map((status) => [status.name, status] as const)).values(),
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  const safeNames = assignMcpCatalogSafeServerNames(orderedStatuses.map((status) => status.name));
  const serverEntries: Array<[string, McpToolCatalog["servers"][string]]> = [];
  const tools: McpToolCatalog["tools"] = [];
  const sessionDeniedTools: NonNullable<McpToolCatalog["sessionDeniedTools"]> = [];

  for (const status of orderedStatuses) {
    const safeServerName = safeNames.get(status.name) ?? status.name;
    const denialMap = toolOverrides?.mcpToolsDeny;
    const deniedNames = new Set(
      denialMap && Object.hasOwn(denialMap, status.name) ? denialMap[status.name] : [],
    );
    const observedNames = new Set(Object.keys(status.tools));
    const toolEntries = [
      ...Object.entries(status.tools).toSorted(([left], [right]) => left.localeCompare(right)),
      ...[...deniedNames]
        .filter((name) => !observedNames.has(name))
        .toSorted()
        .map((name) => [name, undefined] as const),
    ];
    for (const [toolName, raw] of toolEntries) {
      const deniedBySession = deniedNames.has(toolName) ? true : undefined;
      const tool = catalogTool({
        serverName: status.name,
        safeServerName,
        toolName,
        raw,
        ...(deniedBySession ? { deniedBySession } : {}),
      });
      (deniedBySession ? sessionDeniedTools : tools).push(tool);
    }
    serverEntries.push([
      status.name,
      {
        ...projectCodexMcpServerMetadata(status),
        safeServerName,
        toolCount: toolEntries.length,
      },
    ]);
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    servers: Object.fromEntries(serverEntries),
    tools,
    ...(sessionDeniedTools.length > 0 ? { sessionDeniedTools } : {}),
  };
}

async function listCodexMcpServerStatuses(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
): Promise<CodexMcpServerStatus[]> {
  const statuses: CodexMcpServerStatus[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await client.request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    statuses.push(...response.data);
    cursor = response.nextCursor;
    if (!cursor) {
      return statuses;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex mcpServerStatus/list repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex mcpServerStatus/list exceeded the bounded page limit");
}

/** Loads MCP inventory from the bound Codex client while retaining its lease through all pages. */
export async function loadCodexEffectiveMcpCatalog(
  params: AgentHarnessMcpCatalogParams,
  options: { bindingStore: CodexAppServerBindingStore },
): Promise<McpToolCatalog | undefined> {
  const binding = await options.bindingStore.readAsync(
    sessionBindingIdentity({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config: params.config,
    }),
  );
  if (!binding?.clientId) {
    return undefined;
  }
  const retained = await retainSharedCodexAppServerClientByInstanceId(binding.clientId);
  if (!retained) {
    return undefined;
  }
  try {
    const allowedServerNames = new Set(params.mcpServerNames);
    const statuses = (await listCodexMcpServerStatuses(retained.client, binding.threadId)).filter(
      (status) => allowedServerNames.has(status.name),
    );
    return buildCodexEffectiveMcpCatalog(statuses, params.toolOverrides);
  } finally {
    await retained.release();
  }
}

/** Explicit App requests retain the thread owner, never start a second MCP client. */
export async function acquireCodexMcpAppRuntime(
  params: Parameters<NonNullable<AgentHarness["acquireMcpAppRuntime"]>>[0],
  options: { bindingStore: CodexAppServerBindingStore; pluginConfig?: unknown },
) {
  const identity = sessionBindingIdentity(params);
  let binding = await options.bindingStore.readAsync(identity);
  params.assertCurrent();
  let retained = await retainSharedCodexAppServerClientByInstanceId(binding?.clientId);
  if (!retained && params.prepareSession) {
    const preparation = await params.prepareSession();
    params.assertCurrent();
    const { prepareCodexMcpAppSession } = await import("./mcp-app-session-preparation.js");
    await prepareCodexMcpAppSession({
      preparation,
      bindingStore: options.bindingStore,
      pluginConfig: options.pluginConfig,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent();
    binding = await options.bindingStore.readAsync(identity);
    params.assertCurrent();
    retained = await retainSharedCodexAppServerClientByInstanceId(binding?.clientId);
  }
  if (!binding?.clientId || !retained) {
    return undefined;
  }
  const acquired = retained;
  const admittedBinding = binding;
  try {
    const assertBinding = () => {
      const latest = options.bindingStore.read(identity);
      if (
        !latest ||
        latest.clientId !== admittedBinding.clientId ||
        latest.threadId !== admittedBinding.threadId
      ) {
        throw new Error("Native MCP session binding changed");
      }
    };
    params.assertCurrent();
    assertBinding();
    const { createNativeMcpRuntime } = await import("./native-mcp-app.js");
    params.assertCurrent();
    const runtime = createNativeMcpRuntime({
      client: retained.client,
      threadId: binding.threadId,
      attempt: params,
      appRequester: params.appRequester,
      originCallId: "",
      assertCurrent: assertBinding,
    });
    // codex_apps requires a tool-origin connector binding; it cannot be adopted
    // by a generic configured-server entrypoint.
    const allowed = new Set(params.mcpServerNames.filter((name) => name !== "codex_apps"));
    const getCatalog = runtime.getCatalog;
    let catalog: McpToolCatalog | null = null;
    runtime.getCatalog = async () => {
      const loaded = await getCatalog();
      for (const server of Object.values(loaded.servers)) {
        if (server.serverName !== "codex_apps" && server.pluginId) {
          allowed.add(server.serverName);
        }
      }
      catalog = {
        ...loaded,
        servers: Object.fromEntries(
          Object.entries(loaded.servers).filter(([name]) => allowed.has(name)),
        ),
        tools: loaded.tools.filter(
          (tool) =>
            allowed.has(tool.serverName) &&
            !params.toolOverrides?.mcpToolsDeny?.[tool.serverName]?.includes(tool.toolName),
        ),
      };
      return catalog;
    };
    runtime.peekCatalog = () => catalog;
    const unprotect = protectCodexAppServerLiveThread(acquired.client, admittedBinding.threadId);
    let cleanup: Promise<unknown> | undefined;
    runtime.joinCleanup = async () => {
      await cleanup;
    };
    return {
      runtime,
      releaseLease: () => {
        unprotect();
        cleanup = acquired.release();
        void cleanup?.catch(() => undefined);
      },
    };
  } catch (error) {
    await retained.release();
    throw error;
  }
}
