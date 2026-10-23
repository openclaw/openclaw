import {
  normalizeMcpCodexToolAnnotations,
  readMcpAppIcons,
  readMcpAppSettingsCapability,
  readMcpAppToolExtensions,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseCodexPluginMarketplaceId } from "../plugin-marketplace-discovery.js";
import type { CodexMcpServerStatus } from "./protocol-mcp.js";

export function projectCodexMcpServerMetadata(status: CodexMcpServerStatus) {
  const plugin = status.pluginId ? parseCodexPluginMarketplaceId(status.pluginId) : undefined;
  return {
    serverName: status.name,
    launchSummary: "Codex native MCP connection",
    ...(status.pluginId
      ? { pluginId: plugin?.pluginName ?? status.pluginId, marketplace: plugin?.marketplaceName }
      : {}),
    title: status.serverInfo?.title ?? undefined,
    icons: readMcpAppIcons(status.serverInfo?.icons),
    settings: readMcpAppSettingsCapability(status.serverCapabilities),
    toolCount: Object.keys(status.tools).length,
  };
}

export function projectCodexMcpToolMetadata(toolName: string, raw: unknown) {
  const tool = asOptionalRecord(raw);
  return {
    title:
      normalizeOptionalString(tool?.title) ??
      normalizeOptionalString(asOptionalRecord(tool?.annotations)?.title),
    fallbackDescription: normalizeOptionalString(tool?.description) ?? toolName,
    appExtensions: readMcpAppToolExtensions(tool ?? {}),
    codexAnnotations: normalizeMcpCodexToolAnnotations(tool?.annotations),
    uiResourceUri: normalizeOptionalString(
      asOptionalRecord(asOptionalRecord(tool?._meta)?.ui)?.resourceUri,
    ),
  };
}

/** Hosted app ownership is authoritative only on metadata supplied by Codex. */
export function readCodexMcpToolConnectorId(tool: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  return (
    normalizeOptionalString(metadata?.connector_id) ??
    normalizeOptionalString(metadata?.connectorId)
  );
}

/** Preserve MCP App visibility so model-only tools cannot become widget authority. */
export function readCodexMcpToolUiVisibility(tool: unknown): Array<"app" | "model"> | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  const visibility = asOptionalRecord(metadata?.ui)?.visibility;
  if (!Array.isArray(visibility)) {
    return undefined;
  }
  return [
    ...new Set(
      visibility.filter((value): value is "app" | "model" => value === "app" || value === "model"),
    ),
  ].toSorted();
}
