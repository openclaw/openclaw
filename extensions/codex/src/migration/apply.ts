import path from "node:path";
import {
  applyMigrationConfigPatchItem,
  markMigrationItemConflict,
  markMigrationItemError,
  readMigrationConfigPatchDetails,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveCodexAppServerRuntimeOptions } from "../app-server/config.js";
import type { v2 } from "../app-server/protocol-generated/typescript/index.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import { buildCodexMigrationPlan } from "./plan.js";

const OPENAI_CURATED_MARKETPLACE = "openai-curated";
const CODEX_PLUGIN_APPLY_TIMEOUT_MS = 60_000;
const CODEX_CONFIG_ALLOWLIST_ITEM_IDS = new Set(["config:codex-plugin-allowlist"]);

type CodexMigrationAppServerRequest = (method: string, params?: unknown) => Promise<unknown>;

let appServerRequestForTests: CodexMigrationAppServerRequest | undefined;

function readCodexPluginConfigFromOpenClawConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const plugins = (config as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return undefined;
  }
  const entries = (plugins as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return undefined;
  }
  const codex = (entries as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) {
    return undefined;
  }
  return (codex as { config?: unknown }).config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readConfigPath(config: unknown, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function writeConfigPath(root: Record<string, unknown>, path: readonly string[], value: unknown) {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function mergeStringAllowlist(existing: unknown, values: readonly string[]): string[] | undefined {
  if (existing !== undefined && !Array.isArray(existing)) {
    return undefined;
  }
  if (Array.isArray(existing) && !existing.every((value) => typeof value === "string")) {
    return undefined;
  }
  const next = new Set<string>(Array.isArray(existing) ? existing : []);
  for (const value of values) {
    next.add(value);
  }
  return [...next];
}

async function defaultAppServerRequest(
  ctx: MigrationProviderContext,
): Promise<CodexMigrationAppServerRequest> {
  const runtimeOptions = resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfigFromOpenClawConfig(ctx.config),
  });
  const startOptions =
    typeof ctx.source === "string" && ctx.source.trim()
      ? {
          ...runtimeOptions.start,
          env: {
            ...runtimeOptions.start.env,
            CODEX_HOME: ctx.source,
          },
        }
      : runtimeOptions.start;
  return async (method: string, requestParams?: unknown): Promise<unknown> =>
    await requestCodexAppServerJson({
      method,
      requestParams,
      timeoutMs: CODEX_PLUGIN_APPLY_TIMEOUT_MS,
      startOptions,
      config: ctx.config,
    });
}

function readPluginDetail(item: MigrationItem):
  | {
      pluginName: string;
      marketplaceName: string;
      accessible?: boolean;
    }
  | undefined {
  const pluginName = item.details?.pluginName;
  const marketplaceName = item.details?.marketplaceName;
  const accessible = item.details?.accessible;
  if (typeof pluginName !== "string" || typeof marketplaceName !== "string") {
    return undefined;
  }
  return {
    pluginName,
    marketplaceName,
    ...(typeof accessible === "boolean" ? { accessible } : {}),
  };
}

async function refreshCodexPluginRuntime(request: CodexMigrationAppServerRequest): Promise<void> {
  await request("plugin/list", { cwds: [] } satisfies v2.PluginListParams);
  await request("skills/list", {
    cwds: [],
    forceReload: true,
  } satisfies v2.SkillsListParams);
  await request("config/mcpServer/reload", undefined);
  await request("app/list", {
    limit: 100,
    forceRefetch: true,
  } satisfies v2.AppsListParams);
}

async function applyCodexPluginActivationItems(params: {
  ctx: MigrationProviderContext;
  items: MigrationItem[];
}): Promise<MigrationItem[]> {
  if (params.items.length === 0) {
    return [];
  }
  const request = appServerRequestForTests ?? (await defaultAppServerRequest(params.ctx));
  const listed = (await request("plugin/list", {
    cwds: [],
  } satisfies v2.PluginListParams)) as v2.PluginListResponse;
  const marketplace = listed.marketplaces.find(
    (entry) => entry.name === OPENAI_CURATED_MARKETPLACE,
  );
  const applied: MigrationItem[] = [];
  let changed = false;
  for (const item of params.items) {
    const detail = readPluginDetail(item);
    if (!detail) {
      applied.push({ ...item, status: "error", reason: "missing plugin migration metadata" });
      continue;
    }
    if (detail.marketplaceName !== OPENAI_CURATED_MARKETPLACE) {
      applied.push({
        ...item,
        status: "error",
        reason: "only openai-curated Codex plugins can be activated by migration",
      });
      continue;
    }
    const plugin = marketplace?.plugins.find(
      (candidate) =>
        candidate.name === detail.pluginName ||
        candidate.id === detail.pluginName ||
        candidate.id === `${detail.pluginName}@${OPENAI_CURATED_MARKETPLACE}`,
    );
    if (!marketplace || !plugin) {
      applied.push({
        ...item,
        status: "error",
        reason: `openai-curated Codex plugin "${detail.pluginName}" was not found in target app-server inventory`,
      });
      continue;
    }
    if (plugin.installed && plugin.enabled && detail.accessible === false) {
      applied.push({
        ...item,
        status: "error",
        reason: `plugin "${detail.pluginName}" is installed and enabled but its app is not accessible; reauthorize the app before migration can enable it`,
      });
      continue;
    }
    if (plugin.installed && plugin.enabled) {
      applied.push({
        ...item,
        status: "migrated",
        reason: "already installed and enabled",
      });
      continue;
    }
    if (!marketplace.path) {
      applied.push({
        ...item,
        status: "error",
        reason: "openai-curated marketplace path is unavailable",
      });
      continue;
    }
    const installResponse = (await request("plugin/install", {
      marketplacePath: marketplace.path,
      pluginName: detail.pluginName,
    } satisfies v2.PluginInstallParams)) as v2.PluginInstallResponse;
    changed = true;
    const appsNeedingAuth = installResponse.appsNeedingAuth ?? [];
    if (appsNeedingAuth.length > 0) {
      applied.push({
        ...item,
        status: "error",
        reason: `plugin installed but requires app authorization before migration can enable it: ${appsNeedingAuth
          .map((app) => app.name || app.id)
          .join(", ")}`,
      });
      continue;
    }
    applied.push({ ...item, status: "migrated" });
  }
  if (changed) {
    await refreshCodexPluginRuntime(request);
  }
  return applied;
}

async function applyCodexAllowlistConfigPatchItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const details = readMigrationConfigPatchDetails(item);
  const values = details?.value;
  if (!details || !Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return markMigrationItemError(item, "missing allowlist config patch");
  }
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  const current = configApi.current() as MigrationProviderContext["config"];
  const merged = mergeStringAllowlist(readConfigPath(current, details.path), values);
  if (!merged && !ctx.overwrite) {
    return markMigrationItemConflict(item, "target exists");
  }
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const existing = readConfigPath(draft, details.path);
        const next = mergeStringAllowlist(existing, values);
        if (!next && !ctx.overwrite) {
          throw new Error("target exists");
        }
        writeConfigPath(draft as Record<string, unknown>, details.path, next ?? values);
      },
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return reason === "target exists"
      ? markMigrationItemConflict(item, reason)
      : markMigrationItemError(item, reason);
  }
}

export async function applyCodexMigrationPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildCodexMigrationPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
  const items: MigrationItem[] = [];
  const pluginActivationItems = plan.items.filter(
    (item) => item.kind === "plugin" && item.action === "install" && item.status === "planned",
  );
  const appliedPluginItemsById = new Map(
    (
      await applyCodexPluginActivationItems({
        ctx: params.ctx,
        items: pluginActivationItems,
      })
    ).map((item) => [item.id, item]),
  );
  for (const item of plan.items) {
    const appliedPluginItem = appliedPluginItemsById.get(item.id);
    if (appliedPluginItem) {
      items.push(appliedPluginItem);
      continue;
    }
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (item.action === "archive") {
      items.push(await archiveMigrationItem(item, reportDir));
    } else if (
      item.kind === "config" &&
      item.action === "merge" &&
      CODEX_CONFIG_ALLOWLIST_ITEM_IDS.has(item.id)
    ) {
      items.push(await applyCodexAllowlistConfigPatchItem(params.ctx, item));
    } else if (item.kind === "config" && item.action === "merge") {
      items.push(await applyMigrationConfigPatchItem(params.ctx, item));
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

export const __testing = {
  setAppServerRequestForTests(request: CodexMigrationAppServerRequest | undefined): void {
    appServerRequestForTests = request;
  },
};
