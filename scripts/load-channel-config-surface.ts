import { pathToFileURL } from "node:url";
import { buildChannelConfigSchema } from "../src/channels/plugins/config-schema.js";

function isBuiltChannelConfigSchema(
  value: unknown,
): value is { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function resolveConfigSchemaExport(
  imported: Record<string, unknown>,
): { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

const modulePath = process.argv[2]?.trim();
if (!modulePath) {
  process.exit(2);
}

const imported = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
const resolved = resolveConfigSchemaExport(imported);
if (!resolved) {
  process.exit(3);
}

process.stdout.write(JSON.stringify(resolved));
process.exit(0);
