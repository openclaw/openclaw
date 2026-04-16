import { type RerankConfig, type RerankFn, buildRerankWrapper } from "./rerank/index.js";

// Reads the additive `memoryV2.rerank.*` block from the plugin config without
// pulling in a schema validator. Type-guarded so a malformed config never
// enables rerank by accident; default is disabled.
export function readRerankOptions(pluginConfig: unknown): {
  enabled: boolean;
  shadowOnRecall: boolean;
  cfg: RerankConfig;
} {
  const fallback = { enabled: false, shadowOnRecall: false, cfg: {} as RerankConfig };
  if (!isRecord(pluginConfig)) {
    return fallback;
  }
  const memoryV2 = pluginConfig.memoryV2;
  if (!isRecord(memoryV2)) {
    return fallback;
  }
  const rerank = memoryV2.rerank;
  if (!isRecord(rerank)) {
    return fallback;
  }

  const cfg: RerankConfig = {};
  if (typeof rerank.salienceWeight === "number") {
    cfg.salienceWeight = rerank.salienceWeight;
  }
  if (typeof rerank.recencyHalfLifeDays === "number") {
    cfg.recencyHalfLifeDays = rerank.recencyHalfLifeDays;
  }
  if (typeof rerank.pinnedBoost === "number") {
    cfg.pinnedBoost = rerank.pinnedBoost;
  }
  if (typeof rerank.supersededPenalty === "number") {
    cfg.supersededPenalty = rerank.supersededPenalty;
  }

  return {
    enabled: rerank.enabled === true,
    shadowOnRecall: rerank.shadowOnRecall === true,
    cfg,
  };
}

type RegisterApi = { pluginConfig?: unknown };

// Returns a RerankFn when the flag is on, undefined when off. The returned
// function carries its own per-workspace db cache and a try/catch identity
// fallback (see buildRerankWrapper). Built once per plugin activation.
export function buildMemoryV2Rerank(api: RegisterApi): RerankFn | undefined {
  const opts = readRerankOptions(api.pluginConfig);
  if (!opts.enabled) {
    return undefined;
  }
  return buildRerankWrapper({
    enabled: true,
    cfg: opts.cfg,
    shadowOnRecall: opts.shadowOnRecall,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
