import path from "node:path";
import {
  applyMigrationManualItem,
  markMigrationItemError,
  markMigrationItemSkipped,
  summarizeMigrationItems,
  writeMigrationConfigPath,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  type CodexMigratedPluginIdentity,
} from "../app-server/config.js";
import { ensureCodexPluginActivation } from "../app-server/plugin-activation.js";
import type { v2 } from "../app-server/protocol-generated/typescript/index.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import { buildCodexMigrationPlan } from "./plan.js";
import {
  buildCodexPluginsConfigValue,
  CODEX_PLUGIN_CONFIG_ITEM_ID,
  CODEX_PLUGIN_CONFIG_PATH,
  readCodexPluginMigrationConfigEntry,
  type CodexPluginMigrationConfigEntry,
} from "./plan.js";

const CODEX_PLUGIN_AUTH_REQUIRED_REASON = "auth_required";
const CODEX_PLUGIN_NOT_SELECTED_REASON = "not selected for migration";

export async function applyCodexMigrationPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildCodexMigrationPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
  const items: MigrationItem[] = [];
  const runtime = withCachedMigrationConfigRuntime(
    params.ctx.runtime ?? params.runtime,
    params.ctx.config,
  );
  const applyCtx = { ...params.ctx, runtime };
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (item.id === CODEX_PLUGIN_CONFIG_ITEM_ID) {
      items.push(await applyCodexPluginConfigItem(applyCtx, item, items));
    } else if (item.kind === "plugin" && item.action === "install") {
      items.push(await applyCodexPluginInstallItem(applyCtx, item));
    } else if (item.kind === "manual") {
      items.push(applyMigrationManualItem(item));
    } else if (item.action === "archive") {
      items.push(await archiveMigrationItem(item, reportDir));
    } else {
      items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Codex Migration Report" });
  return result;
}

async function applyCodexPluginInstallItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  const identity = readCodexPluginIdentity(item);
  if (!identity) {
    return {
      ...markMigrationItemError(item, "invalid Codex plugin migration item"),
      details: { ...item.details, code: "invalid_plugin_item" },
    };
  }
  try {
    const result = await ensureCodexPluginActivation({
      identity,
      installEvenIfActive: true,
      request: async (method, requestParams) =>
        await requestCodexAppServerJson({
          method,
          requestParams,
          timeoutMs: 60_000,
          config: ctx.config,
        }),
    });
    defaultCodexAppInventoryCache.clear();
    const baseDetails = {
      ...item.details,
      code: result.reason,
      activationReason: result.reason,
      installed: result.installed,
      enabled: result.enabled,
      installAttempted: result.installAttempted,
      diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
    };
    if (result.ok) {
      return {
        ...item,
        status: "migrated",
        ...(result.reason === "already_active" ? { reason: "already active" } : {}),
        details: baseDetails,
      };
    }
    if (result.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON) {
      return {
        ...item,
        status: "skipped",
        reason: CODEX_PLUGIN_AUTH_REQUIRED_REASON,
        details: {
          ...baseDetails,
          appsNeedingAuth: sanitizeAppsNeedingAuth(result.installResponse?.appsNeedingAuth ?? []),
        },
      };
    }
    return {
      ...item,
      status: "error",
      reason: result.reason,
      details: baseDetails,
    };
  } catch (error) {
    return {
      ...item,
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      details: {
        ...item.details,
        code: "plugin_install_failed",
      },
    };
  }
}

async function applyCodexPluginConfigItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  appliedItems: readonly MigrationItem[],
): Promise<MigrationItem> {
  const entries = appliedItems
    .map(readAppliedPluginConfigEntry)
    .filter((entry): entry is CodexPluginMigrationConfigEntry => entry !== undefined);
  if (entries.length === 0) {
    return markMigrationItemSkipped(item, "no selected Codex plugins");
  }
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  const value = buildCodexPluginsConfigValue(entries);
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        writeMigrationConfigPath(draft as Record<string, unknown>, CODEX_PLUGIN_CONFIG_PATH, value);
      },
    });
    return {
      ...item,
      status: "migrated",
      details: {
        ...item.details,
        path: [...CODEX_PLUGIN_CONFIG_PATH],
        value,
      },
    };
  } catch (error) {
    return markMigrationItemError(item, error instanceof Error ? error.message : String(error));
  }
}

function readAppliedPluginConfigEntry(
  item: MigrationItem,
): CodexPluginMigrationConfigEntry | undefined {
  if (item.status === "migrated") {
    return readCodexPluginMigrationConfigEntry(item, true);
  }
  if (
    item.status === "skipped" &&
    item.reason !== CODEX_PLUGIN_NOT_SELECTED_REASON &&
    item.reason === CODEX_PLUGIN_AUTH_REQUIRED_REASON
  ) {
    return readCodexPluginMigrationConfigEntry(item, false);
  }
  if (item.status === "error") {
    return readCodexPluginMigrationConfigEntry(item, false);
  }
  return undefined;
}

function readCodexPluginIdentity(item: MigrationItem): CodexMigratedPluginIdentity | undefined {
  const configKey = item.details?.configKey;
  const marketplaceName = item.details?.marketplaceName;
  const pluginName = item.details?.pluginName;
  if (
    typeof configKey !== "string" ||
    marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
    typeof pluginName !== "string"
  ) {
    return undefined;
  }
  return {
    configKey,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    pluginName,
  };
}

function sanitizeAppsNeedingAuth(apps: readonly v2.AppSummary[]): Array<{
  id: string;
  name: string;
  needsAuth: boolean;
}> {
  return apps.map((app) => ({
    id: app.id,
    name: app.name,
    needsAuth: app.needsAuth,
  }));
}
