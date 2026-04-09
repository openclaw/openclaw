import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { readDenchAuthProfileKey } from "../shared/dench-auth.js";

type UnknownRecord = Record<string, unknown>;

const DENCH_EXECUTE_INTEGRATIONS_NAME = "dench_execute_integrations";
const DENCH_INTEGRATIONS_DISPLAY_NAME = "Dench Integrations";

const DENCH_EXECUTE_INTEGRATIONS_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool_slug: {
      type: "string",
      description: "Exact tool slug returned by dench_search_integrations, for example GMAIL_FETCH_EMAILS or YOUTUBE_LIST_USER_SUBSCRIPTIONS.",
    },
    arguments: {
      type: "object",
      additionalProperties: true,
      description: "JSON arguments object matching the tool's input_schema from the search results.",
      properties: {},
    },
    connected_account_id: {
      type: "string",
      description: "Optional connected account id. Required only when multiple accounts are connected for the same toolkit. The gateway auto-selects when only one account exists.",
    },
  },
  required: ["tool_slug"],
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

function resolveGatewayBaseUrl(api: any, fallbackGatewayUrl: string): string {
  const plugins = asRecord(asRecord(api?.config)?.plugins)?.entries;
  const denchGateway = asRecord(asRecord(plugins)?.["dench-ai-gateway"]);
  const gwConfig = asRecord(denchGateway?.config);
  const configuredUrl = readString(gwConfig?.gatewayUrl);
  return (configuredUrl ?? fallbackGatewayUrl).replace(/\/$/, "");
}

function resolveApiKey(): string | undefined {
  return readDenchAuthProfileKey() ?? undefined;
}

function createDenchExecuteIntegrationsTool(params: {
  gatewayBaseUrl: string;
  authorization?: string;
}): AnyAgentTool {
  return {
    name: DENCH_EXECUTE_INTEGRATIONS_NAME,
    label: `${DENCH_INTEGRATIONS_DISPLAY_NAME} Execute`,
    description:
      `Execute a ${DENCH_INTEGRATIONS_DISPLAY_NAME.toLowerCase()} tool by its slug. Pass the tool_slug from dench_search_integrations and the arguments matching its input_schema. The gateway handles authentication and account selection.`,
    parameters: DENCH_EXECUTE_INTEGRATIONS_PARAMETERS,
    async execute(_toolCallId: string, input: Record<string, unknown>) {
      const payload = asRecord(input) ?? {};
      const toolSlug = readString(payload.tool_slug)?.trim();
      const connectedAccountId = readString(payload.connected_account_id)?.trim();
      const toolArgs = asRecord(payload.arguments) ?? {};

      if (!toolSlug) {
        return jsonResult({
          error: "The `tool_slug` field is required. Use dench_search_integrations to find available tools first.",
        });
      }

      try {
        const res = await fetch(`${params.gatewayBaseUrl}/v1/composio/tools/execute`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(params.authorization ? { authorization: params.authorization } : {}),
          },
          body: JSON.stringify({
            tool_slug: toolSlug,
            arguments: toolArgs,
            ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
          }),
        });

        const text = await res.text();
        let parsed: UnknownRecord | undefined;
        try {
          parsed = JSON.parse(text) as UnknownRecord;
        } catch {
          parsed = undefined;
        }

        if (!res.ok) {
          const errorCode = readString(asRecord(parsed?.error)?.code) ?? readString(parsed?.code);
          const errorMessage = readString(asRecord(parsed?.error)?.message)
            ?? readString(parsed?.error)
            ?? text;

          if (errorCode === "composio_account_selection_required") {
            return jsonResult(
              {
                error: errorMessage,
                account_selection_required: true,
                instruction: "Ask the user which connected account to use and pass its connected_account_id.",
              },
              { status: "error", errorCode, tool_slug: toolSlug },
            );
          }

          if (errorCode === "composio_not_connected") {
            return jsonResult(
              { error: errorMessage, not_connected: true },
              { status: "error", errorCode, tool_slug: toolSlug },
            );
          }

          return jsonResult(
            {
              error: `${DENCH_INTEGRATIONS_DISPLAY_NAME} tool ${toolSlug} failed (HTTP ${res.status}).`,
              detail: parsed ?? (text || undefined),
            },
            { status: "error", tool_slug: toolSlug },
          );
        }

        const data = parsed?.data;
        const error = readString(parsed?.error);
        const contentPayload = error ? { error, data } : (data ?? parsed ?? {});

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(contentPayload, null, 2),
          }],
          details: {
            denchIntegrations: true,
            tool_slug: toolSlug,
            ...(parsed?.log_id ? { logId: parsed.log_id } : {}),
            ...(data !== undefined ? { structuredContent: data } : {}),
            ...(error ? { status: "error", error } : {}),
            ...(connectedAccountId ? { connectedAccountId } : {}),
          },
        };
      } catch (error) {
        return jsonResult(
          {
            error: `${DENCH_INTEGRATIONS_DISPLAY_NAME} tool ${toolSlug} failed.`,
            detail: error instanceof Error ? error.message : String(error),
          },
          { status: "error", tool_slug: toolSlug },
        );
      }
    },
  } as AnyAgentTool;
}

function stripRuntimeComposioServer(api: any): void {
  const rootConfig = asRecord(api?.config);
  const mcp = asRecord(rootConfig?.mcp);
  const servers = asRecord(mcp?.servers);
  if (!rootConfig || !mcp || !servers) return;

  if (servers.composio) {
    delete servers.composio;
    if (Object.keys(servers).length === 0) delete mcp.servers;
    if (Object.keys(mcp).length === 0) delete rootConfig.mcp;
  }
}

export function registerDenchIntegrationsBridge(api: any, fallbackGatewayUrl: string) {
  stripRuntimeComposioServer(api);

  const gatewayBaseUrl = resolveGatewayBaseUrl(api, fallbackGatewayUrl);
  const apiKey = resolveApiKey();
  if (!apiKey) {
    return;
  }

  const tool = createDenchExecuteIntegrationsTool({
    gatewayBaseUrl,
    authorization: `Bearer ${apiKey}`,
  });

  api.registerTool(tool);
  api.logger?.info?.(
    `[dench-ai-gateway] registered ${DENCH_EXECUTE_INTEGRATIONS_NAME} bridge tool`,
  );
}
