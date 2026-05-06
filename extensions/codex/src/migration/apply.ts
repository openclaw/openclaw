import path from "node:path";
import {
  applyMigrationConfigPatchItem,
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

async function defaultAppServerRequest(
  ctx: MigrationProviderContext,
): Promise<CodexMigrationAppServerRequest> {
  const runtimeOptions = resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfigFromOpenClawConfig(ctx.config),
  });
  return async (method: string, requestParams?: unknown): Promise<unknown> =>
    await requestCodexAppServerJson({
      method,
      requestParams,
      timeoutMs: CODEX_PLUGIN_APPLY_TIMEOUT_MS,
      startOptions: runtimeOptions.start,
      config: ctx.config,
    });
}

function readPluginDetail(item: MigrationItem):
  | {
      pluginName: string;
      marketplaceName: string;
    }
  | undefined {
  const pluginName = item.details?.pluginName;
  const marketplaceName = item.details?.marketplaceName;
  if (typeof pluginName !== "string" || typeof marketplaceName !== "string") {
    return undefined;
  }
  return { pluginName, marketplaceName };
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
    await request("plugin/install", {
      marketplacePath: marketplace.path,
      pluginName: detail.pluginName,
    } satisfies v2.PluginInstallParams);
    changed = true;
    applied.push({ ...item, status: "migrated" });
  }
  if (changed) {
    await refreshCodexPluginRuntime(request);
  }
  return applied;
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
