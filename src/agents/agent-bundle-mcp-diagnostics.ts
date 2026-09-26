import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import { listAllMcpTools } from "./mcp-catalog-listing.js";
import { summarizeServerCapabilities } from "./mcp-metadata.js";

type BundleMcpDiagnosticsAttributes = {
  reusedSession: boolean;
  safeServerName: string;
  serverName: string;
  transportType: "stdio" | "sse" | "streamable-http";
};

type BundleMcpCatalogCapabilities = ReturnType<typeof summarizeServerCapabilities>;

function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isRecord(error) && error.code === ErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /\b(?:method not found|unknown method)\b/i.test(message);
}

/** Loads one server catalog while recording nested, redacted discovery spans. */
export async function loadBundleMcpCatalogWithDiagnostics(params: {
  config?: OpenClawConfig;
  attributes: BundleMcpDiagnosticsAttributes;
  assertActive: () => void;
  isConnected: () => boolean;
  connect: () => Promise<void>;
  onConnected: () => void;
  client: Client;
  listTimeoutMs: number;
  signal: AbortSignal;
}): Promise<{ capabilities: BundleMcpCatalogCapabilities; listedTools: Tool[] }> {
  const spanOptions = {
    attributes: params.attributes,
    ...(params.config ? { config: params.config } : {}),
    omitErrorMessage: true,
  };
  return await measureDiagnosticsTimelineSpan(
    "bundle-mcp.server",
    async () => {
      params.assertActive();
      await measureDiagnosticsTimelineSpan(
        "bundle-mcp.connect",
        async () => {
          if (!params.isConnected()) {
            await params.connect();
          }
        },
        spanOptions,
      );
      params.onConnected();
      params.assertActive();
      const capabilities = summarizeServerCapabilities(params.client.getServerCapabilities());
      const listedTools = await measureDiagnosticsTimelineSpan(
        "bundle-mcp.tools-list",
        async () => {
          try {
            return await listAllMcpTools(params.client, params.listTimeoutMs, params.signal);
          } catch (error) {
            if (
              !capabilities.tools &&
              (capabilities.resources || capabilities.prompts) &&
              isMcpMethodNotFoundError(error)
            ) {
              return [];
            }
            throw error;
          }
        },
        spanOptions,
      );
      return { capabilities, listedTools };
    },
    spanOptions,
  );
}
