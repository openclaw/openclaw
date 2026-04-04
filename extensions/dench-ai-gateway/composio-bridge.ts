import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { buildComposioMcpServerConfig } from "./config-patch.js";

type UnknownRecord = Record<string, unknown>;

type ComposioToolIndexFile = {
  generated_at: string;
  connected_apps: Array<{
    toolkit_slug: string;
    toolkit_name: string;
    account_count: number;
    tools: Array<{
      name: string;
      title: string;
      description_short: string;
      required_args: string[];
      arg_hints: Record<string, string>;
      default_args?: Record<string, unknown>;
      example_args?: Record<string, unknown>;
      example_prompts?: string[];
      input_schema?: Record<string, unknown>;
    }>;
    recipes: Record<string, string>;
  }>;
};

type ComposioToolCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

const GENERIC_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: true,
  properties: {},
} as const;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonResult(payload: unknown, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: details ?? payload,
  };
}

function isComposioToolIndexFile(value: unknown): value is ComposioToolIndexFile {
  const rec = asRecord(value);
  return typeof rec?.generated_at === "string" && Array.isArray(rec.connected_apps);
}

function readComposioToolIndex(workspaceDir: string): ComposioToolIndexFile | null {
  const filePath = path.join(workspaceDir, "composio-tool-index.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isComposioToolIndexFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

function resolveWorkspaceDir(api: any): string | undefined {
  const ws = api?.config?.agents?.defaults?.workspace;
  return typeof ws === "string" ? ws.trim() || undefined : undefined;
}

function resolveAuthorizationHeader(headers: unknown): string | undefined {
  const rec = asRecord(headers);
  return readString(rec?.Authorization) ?? readString(rec?.authorization);
}

function stripRuntimeComposioServer(api: any): { url?: string; authorization?: string } | null {
  const rootConfig = asRecord(api?.config);
  const mcp = asRecord(rootConfig?.mcp);
  const servers = asRecord(mcp?.servers);
  if (!rootConfig || !mcp || !servers) {
    return null;
  }
  const composio = asRecord(servers?.composio);
  if (!composio) {
    return null;
  }

  const captured = {
    url: readString(composio.url),
    authorization: resolveAuthorizationHeader(composio.headers),
  };

  delete servers.composio;
  if (Object.keys(servers).length === 0) {
    delete mcp.servers;
  }
  if (mcp && Object.keys(mcp).length === 0) {
    delete rootConfig.mcp;
  }

  return captured;
}

function resolveConfiguredApiKey(api: any): string | undefined {
  const provider = asRecord(api?.config?.models?.providers?.["dench-cloud"]);
  const providerKey = readString(provider?.apiKey)?.trim();
  if (providerKey) {
    return providerKey;
  }

  const envVars = ["DENCH_CLOUD_API_KEY", "DENCH_API_KEY"] as const;
  for (const envVar of envVars) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function resolveComposioServerConfig(api: any, fallbackGatewayUrl: string) {
  const stripped = stripRuntimeComposioServer(api);
  const apiKey = resolveConfiguredApiKey(api);
  if (stripped?.url) {
    return {
      url: stripped.url,
      authorization: stripped.authorization ?? (apiKey ? `Bearer ${apiKey}` : undefined),
    };
  }

  if (!apiKey) {
    return null;
  }

  const config = buildComposioMcpServerConfig(fallbackGatewayUrl, apiKey);
  return {
    url: config.url,
    authorization: config.headers.Authorization,
  };
}

function buildFallbackParameters(tool: ComposioToolIndexFile["connected_apps"][number]["tools"][number]) {
  const fieldNames = [...new Set([...tool.required_args, ...Object.keys(tool.arg_hints)])];
  if (fieldNames.length === 0) {
    return GENERIC_TOOL_PARAMETERS;
  }

  return {
    type: "object",
    additionalProperties: true,
    properties: Object.fromEntries(
      fieldNames.map((field) => [
        field,
        tool.arg_hints[field] ? { description: tool.arg_hints[field] } : {},
      ]),
    ),
    required: tool.required_args,
  };
}

function normalizeToolParameters(tool: ComposioToolIndexFile["connected_apps"][number]["tools"][number]) {
  const schema = asRecord(tool.input_schema);
  if (!schema) {
    return buildFallbackParameters(tool);
  }

  return {
    ...schema,
    type: "object",
    additionalProperties:
      typeof schema.additionalProperties === "boolean" || asRecord(schema.additionalProperties)
        ? schema.additionalProperties
        : true,
  };
}

function extractToolCallResultFromJsonRpcMessage(payload: unknown): ComposioToolCallResult | null {
  const rec = asRecord(payload);
  const result = asRecord(rec?.result);
  if (!result) {
    return null;
  }

  const content = Array.isArray(result.content) ? result.content : undefined;
  const structuredContent = result.structuredContent;
  const hasStructuredContent = Object.hasOwn(result, "structuredContent");
  const isError = result.isError === true;

  if (!content && !hasStructuredContent && !Object.hasOwn(result, "isError")) {
    return null;
  }

  return {
    ...(content ? { content } : {}),
    ...(hasStructuredContent ? { structuredContent } : {}),
    ...(Object.hasOwn(result, "isError") ? { isError } : {}),
  };
}

function parseSseJsonRpcToolCall(body: string): ComposioToolCallResult | null {
  const lines = body.split(/\r?\n/);
  let lastPayload: unknown = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return lastPayload === null ? null : extractToolCallResultFromJsonRpcMessage(lastPayload);
}

async function parseToolCallResponse(res: Response): Promise<ComposioToolCallResult | null> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseJsonRpcToolCall(text);
    if (fromSse) {
      return fromSse;
    }
  }

  try {
    return extractToolCallResultFromJsonRpcMessage(JSON.parse(text) as unknown);
  } catch {
    return parseSseJsonRpcToolCall(text);
  }
}

function toAgentToolResult(toolName: string, result: ComposioToolCallResult) {
  const content =
    Array.isArray(result.content) && result.content.length > 0
      ? result.content
      : result.structuredContent !== undefined
        ? [{ type: "text" as const, text: JSON.stringify(result.structuredContent, null, 2) }]
        : [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: result.isError === true ? "error" : "ok",
                  server: "composio",
                  tool: toolName,
                },
                null,
                2,
              ),
            },
          ];

  const details: Record<string, unknown> = {
    composioBridge: true,
    mcpServer: "composio",
    mcpTool: toolName,
  };
  if (result.structuredContent !== undefined) {
    details.structuredContent = result.structuredContent;
  }
  if (result.isError === true) {
    details.status = "error";
  }

  return {
    content: content as Array<{ type: string; text?: string }>,
    details,
  };
}

async function executeComposioTool(params: {
  url: string;
  authorization?: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  try {
    const res = await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(params.authorization ? { authorization: params.authorization } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: params.toolName,
          arguments: params.input,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonResult(
        {
          error: `Composio tool ${params.toolName} failed (HTTP ${res.status}).`,
          detail: detail || undefined,
        },
        {
          composioBridge: true,
          mcpServer: "composio",
          mcpTool: params.toolName,
          status: "error",
        },
      );
    }

    const parsed = await parseToolCallResponse(res);
    if (!parsed) {
      return jsonResult(
        {
          error: `Composio tool ${params.toolName} returned an unreadable response.`,
        },
        {
          composioBridge: true,
          mcpServer: "composio",
          mcpTool: params.toolName,
          status: "error",
        },
      );
    }

    return toAgentToolResult(params.toolName, parsed);
  } catch (error) {
    return jsonResult(
      {
        error: `Composio tool ${params.toolName} failed.`,
        detail: error instanceof Error ? error.message : String(error),
      },
      {
        composioBridge: true,
        mcpServer: "composio",
        mcpTool: params.toolName,
        status: "error",
      },
    );
  }
}

function buildToolDescription(
  app: ComposioToolIndexFile["connected_apps"][number],
  tool: ComposioToolIndexFile["connected_apps"][number]["tools"][number],
) {
  const summary =
    tool.description_short?.trim() ||
    tool.title?.trim() ||
    `Use the connected ${app.toolkit_name} integration via Composio.`;
  const promptExamples = tool.example_prompts?.filter(Boolean).slice(0, 2) ?? [];
  const suffix = promptExamples.length
    ? ` Typical requests: ${promptExamples.map((sample) => `"${sample}"`).join("; ")}.`
    : "";
  return `${summary} Uses the connected ${app.toolkit_name} account through Dench Cloud's Composio bridge.${suffix}`;
}

function humanizeToolName(name: string) {
  return name
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createRegisteredComposioTools(params: {
  index: ComposioToolIndexFile;
  serverConfig: {
    url: string;
    authorization?: string;
  };
}): AnyAgentTool[] {
  const seen = new Set<string>();
  const out: AnyAgentTool[] = [];

  for (const app of params.index.connected_apps) {
    for (const tool of app.tools) {
      const name = tool.name.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);

      out.push({
        name,
        label: tool.title?.trim() || name,
        description: buildToolDescription(app, tool),
        parameters: normalizeToolParameters(tool),
        execute: async (_toolCallId: string, input: Record<string, unknown>) =>
          await executeComposioTool({
            url: params.serverConfig.url,
            authorization: params.serverConfig.authorization,
            toolName: name,
            input: asRecord(input) ?? {},
          }),
      } as AnyAgentTool);
    }

    for (const [intent, recipeToolName] of Object.entries(app.recipes)) {
      const name = recipeToolName.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);

      const syntheticTool = {
        name,
        title: intent,
        description_short: `Recommended tool for "${intent}" on the connected ${app.toolkit_name} app.`,
        required_args: [],
        arg_hints: {},
      };

      out.push({
        name,
        label: intent || humanizeToolName(name),
        description: buildToolDescription(app, syntheticTool),
        parameters: normalizeToolParameters(syntheticTool),
        execute: async (_toolCallId: string, input: Record<string, unknown>) =>
          await executeComposioTool({
            url: params.serverConfig.url,
            authorization: params.serverConfig.authorization,
            toolName: name,
            input: asRecord(input) ?? {},
          }),
      } as AnyAgentTool);
    }
  }

  return out;
}

export function registerCuratedComposioBridge(api: any, fallbackGatewayUrl: string) {
  const workspaceDir = resolveWorkspaceDir(api);
  const serverConfig = resolveComposioServerConfig(api, fallbackGatewayUrl);
  if (!workspaceDir || !serverConfig?.url) {
    return;
  }

  const index = readComposioToolIndex(workspaceDir);
  if (!index || index.connected_apps.length === 0) {
    api.logger?.info?.(
      "[dench-ai-gateway] Composio bridge active but no local composio-tool-index.json is available yet.",
    );
    return;
  }

  const tools = createRegisteredComposioTools({ index, serverConfig });
  for (const tool of tools) {
    api.registerTool(tool);
  }

  api.logger?.info?.(
    `[dench-ai-gateway] registered ${tools.length} curated Composio bridge tools from composio-tool-index.json`,
  );
}
