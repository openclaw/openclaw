import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  mcpAppEntrypointSchema,
  mcpAppIconSchema,
  mcpAppSettingsCapabilitySchema,
  mcpAppSettingsSchema,
  type McpAppSettings,
  type McpAppToolExtensions,
} from "../shared/mcp-app-extensions.js";

export function readMcpAppSettings(value: unknown): McpAppSettings {
  const settings = mcpAppSettingsSchema.parse(value);
  for (const key of Object.keys(settings.schema.properties)) {
    if (!Object.hasOwn(settings.values, key)) {
      throw new Error(`MCP settings missing effective value for ${key}`);
    }
  }
  return settings;
}
export function readMcpAppSettingsCapability(capabilities: unknown) {
  const record = asOptionalRecord(capabilities);
  // MCP 2025-11-25 and earlier also allow the experimental capability placement.
  const value =
    asOptionalRecord(record?.extensions)?.["openai/settings"] ??
    asOptionalRecord(record?.experimental)?.["openai/settings"];
  const parsed = mcpAppSettingsCapabilitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function readMcpAppIcons(value: unknown) {
  const parsed = z.array(mcpAppIconSchema).max(16).safeParse(value);
  return parsed.success && parsed.data.length ? parsed.data : undefined;
}
/** Decode advertised metadata without conferring visibility or execution authority. */
export function readMcpAppToolExtensions(tool: {
  _meta?: unknown;
  icons?: unknown;
}): McpAppToolExtensions | undefined {
  const meta = asOptionalRecord(tool._meta);
  const ui = asOptionalRecord(meta?.["openai/ui"]);
  const entrypoints = Array.isArray(ui?.entrypoints)
    ? ui.entrypoints.slice(0, 16).flatMap((value) => {
        const parsed = mcpAppEntrypointSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const visibility = asOptionalRecord(meta?.ui)?.visibility;
  const mentionSearch =
    Array.isArray(visibility) &&
    visibility.includes("app") &&
    asOptionalRecord(asOptionalRecord(meta?.["openai/extensions"])?.["mentions/search"]) !==
      undefined;
  const icons = readMcpAppIcons(tool.icons);
  const mode = ui?.preferredModelDisplayMode;
  return entrypoints.length || mentionSearch || icons || mode === "inline" || mode === "fullscreen"
    ? {
        ...(entrypoints.length ? { entrypoints } : {}),
        ...(mentionSearch ? { mentionSearch: true } : {}),
        ...(icons ? { icons } : {}),
        ...(mode === "inline" || mode === "fullscreen" ? { preferredModelDisplayMode: mode } : {}),
      }
    : undefined;
}
