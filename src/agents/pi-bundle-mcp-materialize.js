import crypto from "node:crypto";
import { logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { buildSafeToolName, normalizeReservedToolNames, TOOL_NAME_SEPARATOR, } from "./pi-bundle-mcp-names.js";
function toAgentToolResult(params) {
    const content = Array.isArray(params.result.content)
        ? params.result.content
        : [];
    const normalizedContent = content.length > 0
        ? content
        : params.result.structuredContent !== undefined
            ? [
                {
                    type: "text",
                    text: JSON.stringify(params.result.structuredContent, null, 2),
                },
            ]
            : [
                {
                    type: "text",
                    text: JSON.stringify({
                        status: params.result.isError === true ? "error" : "ok",
                        server: params.serverName,
                        tool: params.toolName,
                    }, null, 2),
                },
            ];
    const details = {
        mcpServer: params.serverName,
        mcpTool: params.toolName,
    };
    if (params.result.structuredContent !== undefined) {
        details.structuredContent = params.result.structuredContent;
    }
    if (params.result.isError === true) {
        details.status = "error";
    }
    return {
        content: normalizedContent,
        details,
    };
}
export async function materializeBundleMcpToolsForRun(params) {
    let disposed = false;
    const releaseLease = params.runtime.acquireLease?.();
    params.runtime.markUsed();
    let catalog;
    try {
        catalog = await params.runtime.getCatalog();
    }
    catch (error) {
        releaseLease?.();
        throw error;
    }
    const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
    const tools = [];
    const sortedCatalogTools = [...catalog.tools].toSorted((a, b) => {
        const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
        if (serverOrder !== 0) {
            return serverOrder;
        }
        const toolOrder = a.toolName.localeCompare(b.toolName);
        if (toolOrder !== 0) {
            return toolOrder;
        }
        return a.serverName.localeCompare(b.serverName);
    });
    for (const tool of sortedCatalogTools) {
        const originalName = tool.toolName.trim();
        if (!originalName) {
            continue;
        }
        const safeToolName = buildSafeToolName({
            serverName: tool.safeServerName,
            toolName: originalName,
            reservedNames,
        });
        if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
            logWarn(`bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`);
        }
        reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
        const agentTool = {
            name: safeToolName,
            label: tool.title ?? tool.toolName,
            description: tool.description || tool.fallbackDescription,
            parameters: tool.inputSchema,
            execute: async (_toolCallId, input) => {
                params.runtime.markUsed();
                const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
                return toAgentToolResult({
                    serverName: tool.serverName,
                    toolName: tool.toolName,
                    result,
                });
            },
        };
        setPluginToolMeta(agentTool, {
            pluginId: "bundle-mcp",
            optional: false,
        });
        tools.push(agentTool);
    }
    // Sort tools deterministically by name so the tools block in API requests is stable across
    // turns (defensive — listTools() order is usually stable but not guaranteed).
    // Cannot fix name collisions: collision suffixes above are order-dependent.
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
        tools,
        dispose: async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            releaseLease?.();
            await params.disposeRuntime?.();
        },
    };
}
export async function createBundleMcpToolRuntime(params) {
    const createRuntime = params.createRuntime ?? (await import("./pi-bundle-mcp-runtime.js")).createSessionMcpRuntime;
    const runtime = createRuntime({
        sessionId: `bundle-mcp:${crypto.randomUUID()}`,
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
    });
    const materialized = await materializeBundleMcpToolsForRun({
        runtime,
        reservedToolNames: params.reservedToolNames,
        disposeRuntime: async () => {
            await runtime.dispose();
        },
    });
    return materialized;
}
