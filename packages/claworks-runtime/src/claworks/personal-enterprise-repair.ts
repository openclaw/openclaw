import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaworksRobotConfig } from "./config-types.js";
import type { ProductConfigRepairResult } from "./product-config-repair.js";
import { repairVectorKnowledgeBase } from "./product-config-repair.js";

/** Plugins for solo enterprise (Feishu + KB + docs); excludes Ali `qwen` channel plugin. */
export const PERSONAL_WORK_PLUGIN_ALLOW = [
  "claworks-robot",
  "feishu",
  "webhooks",
  "memory-core",
  "memory-lancedb",
  "skill-workshop",
  "openai",
  "file-transfer",
  "document-extract",
] as const;

export const PERSONAL_WORK_PACK_IDS = [
  "base",
  "enterprise-general",
  "enterprise-commercial",
  "personal-enterprise",
] as const;

export type SelfHostedQwenEnv = {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
};

export function detectSelfHostedProviderFromConfig(
  config: Record<string, unknown>,
): (SelfHostedQwenEnv & { providerId: string }) | null {
  const models = config.models as
    | { providers?: Record<string, Record<string, unknown>> }
    | undefined;
  const providers = models?.providers;
  if (!providers) {
    return null;
  }
  for (const [providerId, spec] of Object.entries(providers)) {
    if (spec.api !== "openai-completions" || typeof spec.baseUrl !== "string") {
      continue;
    }
    const modelList = spec.models;
    const first =
      Array.isArray(modelList) && modelList.length > 0
        ? (modelList[0] as { id?: string })
        : undefined;
    const chatModel = first?.id?.trim();
    if (!chatModel) {
      continue;
    }
    return {
      providerId,
      baseUrl: spec.baseUrl.replace(/\/$/, ""),
      apiKey: typeof spec.apiKey === "string" ? spec.apiKey : "local",
      chatModel,
      embedModel:
        process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() ||
        process.env.CLAWORKS_KB_EMBED_MODEL?.trim() ||
        "text-embedding-v3",
    };
  }
  return null;
}

export function resolveSelfHostedQwenFromEnv(
  config?: Record<string, unknown>,
): SelfHostedQwenEnv & { providerId: string } {
  const fromEnvUrl = process.env.CLAWORKS_QWEN_BASE_URL?.trim();
  if (fromEnvUrl) {
    const baseUrl = (
      fromEnvUrl ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "http://127.0.0.1:8000/v1"
    ).replace(/\/$/, "");
    return {
      providerId: "qwen-local",
      baseUrl,
      apiKey:
        process.env.CLAWORKS_QWEN_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "local",
      chatModel: process.env.CLAWORKS_QWEN_CHAT_MODEL?.trim() || "qwen3",
      embedModel:
        process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() ||
        process.env.CLAWORKS_KB_EMBED_MODEL?.trim() ||
        "text-embedding-v3",
    };
  }
  const existing = config ? detectSelfHostedProviderFromConfig(config) : null;
  if (existing) {
    return existing;
  }
  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "http://127.0.0.1:8000/v1").replace(
    /\/$/,
    "",
  );
  return {
    providerId: "qwen-local",
    baseUrl,
    apiKey:
      process.env.CLAWORKS_QWEN_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "local",
    chatModel: process.env.CLAWORKS_QWEN_CHAT_MODEL?.trim() || "qwen3",
    embedModel:
      process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() ||
      process.env.CLAWORKS_KB_EMBED_MODEL?.trim() ||
      "text-embedding-v3",
  };
}

function parseKbWatchDirs(): string[] {
  const raw = process.env.CLAWORKS_KB_WATCH_DIRS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const home = homedir();
  return [
    join(home, "Projects", "claworks", "docs"),
    join(home, "Projects", "claworks-packs"),
    join(home, "Documents"),
  ].filter((p) => p.length > 0);
}

/**
 * Personal enterprise profile: Feishu OA packs, vector KB, self-hosted Qwen via `models.providers.qwen-local` + `openai` plugin (not `qwen` extension).
 */
export function repairPersonalEnterpriseProfile(
  config: Record<string, unknown>,
): ProductConfigRepairResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  let changed = false;
  const qwen = resolveSelfHostedQwenFromEnv(config);

  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  config.plugins = plugins;
  const allow = [...PERSONAL_WORK_PLUGIN_ALLOW];
  if (JSON.stringify(plugins.allow) !== JSON.stringify(allow)) {
    plugins.allow = allow;
    actions.push(`plugins.allow -> personal_work (${allow.length} plugins, no Ali qwen channel)`);
    changed = true;
  }

  plugins.slots = { memory: "memory-lancedb", ...(plugins.slots as object) };

  const models = (config.models ?? {}) as Record<string, unknown>;
  config.models = models;
  const providers = (models.providers ?? {}) as Record<string, Record<string, unknown>>;
  const providerId = qwen.providerId;
  const existingProvider = providers[providerId];
  const nextProvider = {
    ...existingProvider,
    baseUrl: qwen.baseUrl,
    apiKey: existingProvider?.apiKey ?? qwen.apiKey,
    api: "openai-completions",
    models: existingProvider?.models ?? [
      {
        id: qwen.chatModel,
        name: "Qwen (self-hosted)",
      },
    ],
  };
  if (JSON.stringify(existingProvider) !== JSON.stringify(nextProvider)) {
    providers[providerId] = nextProvider;
    models.providers = providers;
    actions.push(`models.providers.${providerId} preserved (${qwen.chatModel})`);
    changed = true;
  }

  const agents = (config.agents ?? {}) as Record<string, unknown>;
  config.agents = agents;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  agents.defaults = defaults;
  const primary = `${providerId}/${qwen.chatModel}`;
  const model = (defaults.model ?? {}) as Record<string, unknown>;
  if (!model.primary) {
    defaults.model = { ...model, primary };
    actions.push(`agents.defaults.model.primary -> ${primary}`);
    changed = true;
  }

  const entries = (plugins.entries ?? {}) as Record<string, Record<string, unknown>>;
  plugins.entries = entries;
  entries["claworks-robot"] ??= { enabled: true, config: {} };
  entries["claworks-robot"].enabled = true;
  const robotCfg = (entries["claworks-robot"].config ?? {}) as ClaworksRobotConfig &
    Record<string, unknown>;
  entries["claworks-robot"].config = robotCfg;

  robotCfg.data ??= {};
  if (robotCfg.data.kb_provider !== "memory-core") {
    robotCfg.data.kb_provider = "memory-core";
    changed = true;
    actions.push("data.kb_provider = memory-core");
  }
  if (robotCfg.data.kb_embed_model !== qwen.embedModel) {
    robotCfg.data.kb_embed_model = qwen.embedModel;
    changed = true;
    actions.push(`data.kb_embed_model = ${qwen.embedModel}`);
  }
  const watchDirs = parseKbWatchDirs();
  const existingDirs = robotCfg.data.kb_watch_dirs ?? [];
  if (JSON.stringify(existingDirs) !== JSON.stringify(watchDirs)) {
    robotCfg.data.kb_watch_dirs = watchDirs;
    changed = true;
    actions.push(`data.kb_watch_dirs (${watchDirs.length} paths)`);
  }

  robotCfg.model_router ??= {};
  if (robotCfg.model_router.chat !== primary) {
    robotCfg.model_router.chat = primary;
    changed = true;
  }
  if (robotCfg.model_router.embed !== qwen.embedModel) {
    robotCfg.model_router.embed = qwen.embedModel;
    changed = true;
  }

  robotCfg.kernel ??= {};
  if (robotCfg.kernel.scheduler_timezone !== "Asia/Shanghai") {
    robotCfg.kernel.scheduler_timezone = "Asia/Shanghai";
    changed = true;
    actions.push("kernel.scheduler_timezone = Asia/Shanghai");
  }

  robotCfg.im_bridge ??= {};
  if (robotCfg.im_bridge.auto_on_message_received !== true) {
    robotCfg.im_bridge.auto_on_message_received = true;
    changed = true;
    actions.push("im_bridge.auto_on_message_received = true");
  }

  robotCfg.notify ??= {};
  if (robotCfg.notify.default_channel !== "feishu") {
    robotCfg.notify.default_channel = "feishu";
    changed = true;
  }

  robotCfg.packs ??= { paths: [], installed: [] };
  const packPaths = [
    ...(robotCfg.packs.paths ?? []),
    process.env.CLAWORKS_PACKS_DIR?.trim(),
    join(process.cwd(), "..", "claworks-packs"),
    join(process.cwd(), "claworks-packs"),
  ].filter((p): p is string => typeof p === "string" && Boolean(p.trim()) && existsSync(p));
  robotCfg.packs.paths = [...new Set(packPaths)];
  const installed = [...new Set([...PERSONAL_WORK_PACK_IDS, ...(robotCfg.packs.installed ?? [])])];
  if (JSON.stringify(robotCfg.packs.installed) !== JSON.stringify(installed)) {
    robotCfg.packs.installed = installed;
    changed = true;
    actions.push(`packs.installed: ${installed.join(", ")}`);
  }

  robotCfg.connectors ??= {};
  const fsConnector = {
    preset: "filesystem-kb",
    enabled: true,
    env: {
      CLAWORKS_KB_WATCH_DIRS: watchDirs.join(","),
      CLAWORKS_KB_WATCH_INTERVAL_MS: process.env.CLAWORKS_KB_WATCH_INTERVAL_MS?.trim() || "300000",
      CLAWORKS_KB_NAMESPACE: process.env.CLAWORKS_KB_NAMESPACE?.trim() || "work",
    },
  };
  const prev = robotCfg.connectors["filesystem-kb"];
  if (JSON.stringify(prev) !== JSON.stringify(fsConnector)) {
    robotCfg.connectors["filesystem-kb"] = fsConnector;
    changed = true;
    actions.push("connectors.filesystem-kb enabled");
  }

  entries["memory-lancedb"] ??= { enabled: true, config: {} };
  entries["memory-lancedb"].enabled = true;
  const lanceCfg = (entries["memory-lancedb"].config ?? {}) as Record<string, unknown>;
  entries["memory-lancedb"].config = lanceCfg;
  const embedding = (lanceCfg.embedding ?? {}) as Record<string, unknown>;
  const nextEmbed = {
    ...embedding,
    provider: "openai",
    model: qwen.embedModel,
    baseUrl: qwen.baseUrl,
    apiKey: qwen.apiKey,
  };
  if (JSON.stringify(embedding) !== JSON.stringify(nextEmbed)) {
    lanceCfg.embedding = nextEmbed;
    actions.push("memory-lancedb.embedding -> self-hosted OpenAI-compatible");
    changed = true;
  }

  const vectorRepair = repairVectorKnowledgeBase(config, { force: true });
  actions.push(...vectorRepair.actions);
  warnings.push(...vectorRepair.warnings);
  if (vectorRepair.changed) {
    changed = true;
  }

  if (!process.env.CLAWORKS_QWEN_BASE_URL?.trim() && !detectSelfHostedProviderFromConfig(config)) {
    warnings.push("Set CLAWORKS_QWEN_BASE_URL or models.providers.*.baseUrl for self-hosted Qwen");
  } else if (!process.env.CLAWORKS_QWEN_BASE_URL?.trim()) {
    warnings.push(
      `Using existing models.providers.${providerId} (self-hosted, not Ali qwen plugin)`,
    );
  }
  warnings.push(
    "LLM uses models.providers.qwen-local + openai plugin — do NOT enable plugins/qwen (Alibaba cloud API key)",
  );

  return { changed, actions, warnings };
}

export function isPersonalWorkProfile(): boolean {
  return process.env.CLAWORKS_PRODUCT_PROFILE?.trim() === "personal_work";
}
