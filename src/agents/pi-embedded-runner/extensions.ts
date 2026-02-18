import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import { loadSwappedFileStoreSync } from "../context-decay/file-store.js";
import {
  resolveContextDecayConfig,
  isContextDecayActive,
} from "../context-decay/resolve-config.js";
import { loadGroupSummaryStoreSync, loadSummaryStoreSync } from "../context-decay/summary-store.js";
import { ContextLifecycleEmitter } from "../context-lifecycle/emitter.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import { setContextDecayRuntime } from "../pi-extensions/context-decay/runtime.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { log } from "./logger.js";

function resolvePiExtensionPath(id: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  // In dev this file is `.ts` (tsx), in production it's `.js`.
  const ext = path.extname(self) === ".ts" ? "ts" : "js";
  return path.join(dir, "..", "pi-extensions", `${id}.${ext}`);
}

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningExtension(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
  lifecycleEmitter?: ContextLifecycleEmitter;
}): { additionalExtensionPaths?: string[] } {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return {};
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return {};
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return {};
  }

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
    lifecycleEmitter: params.lifecycleEmitter,
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-pruning")],
  };
}

function resolveLifecycleEmitter(params: {
  cfg: OpenClawConfig | undefined;
  sessionKey?: string;
  sessionId?: string;
  contextWindowTokens: number;
}): ContextLifecycleEmitter | undefined {
  const logCfg = params.cfg?.agents?.defaults?.contextLifecycleLog;
  if (!logCfg?.enabled) {
    return undefined;
  }
  if (!params.sessionKey || !params.sessionId) {
    return undefined;
  }
  const fileTemplate = logCfg.filePath ?? "logs/context-lifecycle.jsonl";
  const safeSessionKey = path
    .basename(params.sessionKey)
    .replace(/[\\/:]/g, "_")
    .replace(/\.\.+/g, "_");
  const filePath = fileTemplate.replace(/\{sessionKey\}/g, safeSessionKey);
  return new ContextLifecycleEmitter(
    filePath,
    params.sessionKey,
    params.sessionId,
    params.contextWindowTokens,
  );
}

function buildContextDecayExtension(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  sessionKey?: string;
  sessionFile?: string;
  lifecycleEmitter?: ContextLifecycleEmitter;
}): { additionalExtensionPaths?: string[]; resolvedConfig?: ContextDecayConfig } {
  const config = resolveContextDecayConfig(params.sessionKey, params.cfg);
  if (!isContextDecayActive(config)) {
    return {};
  }

  const summaryStore = params.sessionFile ? loadSummaryStoreSync(params.sessionFile) : {};
  const groupSummaryStore = params.sessionFile ? loadGroupSummaryStoreSync(params.sessionFile) : [];
  const swappedFileStore = params.sessionFile ? loadSwappedFileStoreSync(params.sessionFile) : {};

  setContextDecayRuntime(params.sessionManager, {
    config: config!,
    summaryStore,
    groupSummaryStore,
    swappedFileStore,
    lifecycleEmitter: params.lifecycleEmitter,
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-decay")],
    resolvedConfig: config,
  };
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionPaths(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
  sessionKey?: string;
  sessionId?: string;
  sessionFile?: string;
}): {
  paths: string[];
  contextDecayConfig?: ContextDecayConfig;
  lifecycleEmitter?: ContextLifecycleEmitter;
} {
  const paths: string[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
    });
    paths.push(resolvePiExtensionPath("compaction-safeguard"));
  }
  const contextWindowTokens = resolveContextWindowTokens(params);
  const lifecycleEmitter = resolveLifecycleEmitter({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    contextWindowTokens,
  });
  const pruning = buildContextPruningExtension({ ...params, lifecycleEmitter });
  if (pruning.additionalExtensionPaths) {
    paths.push(...pruning.additionalExtensionPaths);
  }
  const decay = buildContextDecayExtension({
    cfg: params.cfg,
    sessionManager: params.sessionManager,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    lifecycleEmitter,
  });
  if (decay.additionalExtensionPaths) {
    paths.push(...decay.additionalExtensionPaths);
  }
  if (pruning.additionalExtensionPaths && decay.additionalExtensionPaths) {
    log.warn(
      "contextDecay and contextPruning (cache-ttl) are both active — " +
        "they serve overlapping purposes and may interfere. " +
        "Consider setting contextPruning.mode to 'off' when using contextDecay.",
    );
  }
  return { paths, contextDecayConfig: decay.resolvedConfig, lifecycleEmitter };
}

export { ensurePiCompactionReserveTokens };
