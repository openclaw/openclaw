import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "../openclaw.plugin.json" with { type: "json" };

export const DEFAULT_RELAY_URL = "https://mcp.openclaw.ai";

export type McpRelayConfig = {
  relayUrl: string;
  agentId?: string;
};

export function parseMcpRelayConfig(raw: unknown): McpRelayConfig {
  const value = raw === undefined ? {} : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP relay config must be an object.");
  }
  if (Object.keys(value).some((key) => key !== "relayUrl" && key !== "agentId")) {
    throw new Error("MCP relay config supports only relayUrl and agentId.");
  }
  const relayUrl = "relayUrl" in value ? value.relayUrl : DEFAULT_RELAY_URL;
  if (
    typeof relayUrl !== "string" ||
    !new RegExp(manifest.configSchema.properties.relayUrl.pattern).test(relayUrl)
  ) {
    throw new Error(
      "relayUrl must be an HTTPS origin without credentials, a path, query, or fragment; use HTTP only with localhost or 127.0.0.1 for development.",
    );
  }
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new Error("relayUrl must be a valid relay origin. Check its hostname and port.");
  }
  if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("relayUrl must contain only the relay origin. Remove credentials and paths.");
  }
  const agentId = "agentId" in value ? value.agentId : undefined;
  if (agentId !== undefined && (typeof agentId !== "string" || !agentId.trim())) {
    throw new Error("agentId must be a nonempty agent ID. Omit it to use the Gateway default.");
  }
  return { relayUrl: url.origin, ...(agentId === undefined ? {} : { agentId }) };
}

export const mcpRelayConfigSchema: OpenClawPluginConfigSchema = {
  jsonSchema: manifest.configSchema,
  safeParse(value) {
    try {
      return { success: true, data: parseMcpRelayConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [
            {
              path: [],
              message: error instanceof Error ? error.message : "Invalid MCP relay config.",
            },
          ],
        },
      };
    }
  },
};
