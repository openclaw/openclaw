import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { McpAppSettings, McpAppToolExtensions } from "../shared/mcp-app-extensions.js";

const text = z.string().trim().min(1).max(2_048);
const iconSchema = z.object({
  src: text,
  mimeType: text.optional(),
  sizes: z.array(text).max(16).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});
const quickActionSchema = z.object({
  title: text,
  icons: z.array(iconSchema).min(1).max(16),
  target: z.object({
    type: z.literal("tool"),
    name: text,
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
});
const entrypointSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global"), quickAction: quickActionSchema.optional() }),
  z.object({ type: z.literal("thread") }),
  z.object({
    type: z.literal("file"),
    extensions: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\.[^\s/\\,]+$/),
      )
      .min(1)
      .max(64),
  }),
  z.object({ type: z.literal("settings"), searchTerms: z.array(text).max(64).optional() }),
]);
const settingsCapabilitySchema = z.object({ readTool: text, updateTool: text });
const title = { title: text, description: z.string().max(8_192).optional() };
const settingSchema = z.discriminatedUnion("type", [
  z.object({ ...title, type: z.literal("boolean") }),
  z.object({
    ...title,
    type: z.literal("string"),
    enum: z.array(z.string()).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
  }),
  ...(["number", "integer"] as const).map((type) =>
    z.object({
      ...title,
      type: z.literal(type),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      multipleOf: z.number().positive().optional(),
    }),
  ),
]);
const mcpAppSettingsSchema = z.object({
  schema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), settingSchema),
    required: z.array(text).optional(),
  }),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  layout: z
    .array(
      z.object({
        kind: z.literal("group"),
        title: text,
        items: z.array(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("property"), property: text }),
            z.object({ kind: z.literal("tool"), tool: text, ...title }),
          ]),
        ),
      }),
    )
    .optional(),
});
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
  const parsed = settingsCapabilitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function readMcpAppIcons(value: unknown) {
  const parsed = z.array(iconSchema).max(16).safeParse(value);
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
        const parsed = entrypointSchema.safeParse(value);
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
