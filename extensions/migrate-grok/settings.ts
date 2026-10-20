import {
  applyMigrationConfigPatchItem,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  resolveMigrationConfigRuntime,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GrokSourceInventory } from "./source/types.js";

/** Grok's explicit override takes precedence over its detected timezone. */
export function grokTimezone(inventory: GrokSourceInventory): string | undefined {
  const settings = inventory.settings.value;
  const value =
    normalizeOptionalString(settings.userTimeZoneOverride) ??
    normalizeOptionalString(settings.userTimeZone);
  if (!value) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return value;
  } catch {
    return undefined;
  }
}

export function planGrokSettings(params: {
  inventory: GrokSourceInventory;
  ctx: MigrationProviderContext;
}): MigrationItem[] {
  const { inventory, ctx } = params;
  const items: MigrationItem[] = [];
  const settings = inventory.settings.value;
  const timezone = grokTimezone(inventory);
  if (timezone) {
    const path = ["agents", "defaults", "userTimezone"];
    items.push(
      createMigrationConfigPatchItem({
        id: "config:grok:timezone",
        source: `${inventory.source}#settings.userTimeZone`,
        target: "agents.defaults.userTimezone",
        path,
        value: timezone,
        conflict:
          !ctx.overwrite &&
          ctx.config.agents?.defaults?.userTimezone !== timezone &&
          hasMigrationConfigPatchConflict(ctx.config, path, timezone),
        message: "Use the Grok user's timezone in OpenClaw.",
      }),
    );
  } else if (settings.userTimeZoneOverride || settings.userTimeZone) {
    items.push(
      createMigrationManualItem({
        id: "manual:grok:timezone",
        source: `${inventory.source}#settings.userTimeZone`,
        message: "The source timezone is not a recognized timezone.",
        recommendation: "Set agents.defaults.userTimezone to the intended IANA timezone.",
      }),
    );
  }
  for (const key of Object.keys(settings).toSorted()) {
    if (["userTimeZone", "userTimeZoneOverride", "mainAgentId"].includes(key)) {
      continue;
    }
    items.push(
      createMigrationManualItem({
        id: `manual:grok:setting:${key}`,
        source: `${inventory.source}#settings.${key}`,
        message: `Grok setting "${key}" has no verified OpenClaw equivalent.`,
        recommendation:
          key === "toolPermissions"
            ? "Review native tool permissions before allowing imported agents to use tools."
            : key === "computerUseModel"
              ? "Select an available OpenClaw model; Grok's computer-use model is service-specific."
              : "Review the archived source settings and configure the corresponding preference manually.",
      }),
    );
  }
  return items;
}

export async function applyGrokSettingsItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  if (
    item.id === "config:grok:timezone" &&
    typeof item.details?.value === "string" &&
    resolveMigrationConfigRuntime(ctx)?.current().agents?.defaults?.userTimezone ===
      item.details.value
  ) {
    return { ...item, status: "migrated" };
  }
  return await applyMigrationConfigPatchItem(ctx, item);
}
