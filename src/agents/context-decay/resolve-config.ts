import type { OpenClawConfig } from "../../config/config.js";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import { log } from "../pi-embedded-runner/logger.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Merge two ContextDecayConfig objects. Fields from `override` take precedence.
 * Only positive integer fields are accepted (0/negative/null = disabled = skip).
 */
function mergeDecayConfig(
  base: ContextDecayConfig | undefined,
  override: ContextDecayConfig | undefined,
): ContextDecayConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  const merged: ContextDecayConfig = {};

  const pickPositiveInt = (a: number | undefined, b: number | undefined): number | undefined => {
    if (typeof b === "number" && Number.isInteger(b) && b >= 1) {
      return b;
    }
    if (typeof a === "number" && Number.isInteger(a) && a >= 1) {
      return a;
    }
    return undefined;
  };

  merged.stripThinkingAfterTurns = pickPositiveInt(
    base?.stripThinkingAfterTurns,
    override?.stripThinkingAfterTurns,
  );
  merged.summarizeToolResultsAfterTurns = pickPositiveInt(
    base?.summarizeToolResultsAfterTurns,
    override?.summarizeToolResultsAfterTurns,
  );
  merged.summarizeWindowAfterTurns = pickPositiveInt(
    base?.summarizeWindowAfterTurns,
    override?.summarizeWindowAfterTurns,
  );
  merged.summarizeWindowSize = pickPositiveInt(
    base?.summarizeWindowSize,
    override?.summarizeWindowSize,
  );
  merged.stripToolResultsAfterTurns = pickPositiveInt(
    base?.stripToolResultsAfterTurns,
    override?.stripToolResultsAfterTurns,
  );
  merged.maxContextMessages = pickPositiveInt(
    base?.maxContextMessages,
    override?.maxContextMessages,
  );
  merged.summarizationModel = override?.summarizationModel ?? base?.summarizationModel;
  merged.groupSummarizationModel =
    override?.groupSummarizationModel ?? base?.groupSummarizationModel;

  // Check if anything is actually enabled
  const hasAnything =
    merged.stripThinkingAfterTurns !== undefined ||
    merged.summarizeToolResultsAfterTurns !== undefined ||
    merged.summarizeWindowAfterTurns !== undefined ||
    merged.stripToolResultsAfterTurns !== undefined ||
    merged.maxContextMessages !== undefined;

  if (!hasAnything) {
    return undefined;
  }

  return merged;
}

/**
 * Enforce graduated decay ordering: stripping must happen AFTER individual summarization.
 * If strip <= summarize, summaries would be generated but never displayed (wasted API calls).
 * Auto-clamps stripToolResultsAfterTurns to summarizeToolResultsAfterTurns + 1.
 * Mutates the config in-place and returns it for chaining.
 */
function enforceDecayOrdering(config: ContextDecayConfig): ContextDecayConfig {
  const summarize = config.summarizeToolResultsAfterTurns;
  const groupSummarize = config.summarizeWindowAfterTurns;
  const strip = config.stripToolResultsAfterTurns;

  // Only enforce strip > individual summarize. Individual summaries are consumed
  // by the VIEW, so stripping before summarization wastes API calls.
  if (typeof strip === "number" && typeof summarize === "number" && strip <= summarize) {
    const clamped = summarize + 1;
    config.stripToolResultsAfterTurns = clamped;
    log.info(
      `context-decay: stripToolResultsAfterTurns ${strip} -> ${clamped} (must be > summarizeToolResultsAfterTurns=${summarize})`,
    );
  }

  // Advisory only: group summarizer reads the raw snapshot, not the decayed view,
  // so strip < groupSummarize is fine — no enforcement needed.
  if (typeof strip === "number" && typeof groupSummarize === "number" && strip <= groupSummarize) {
    log.info(
      `context-decay: stripToolResultsAfterTurns (${strip}) <= summarizeWindowAfterTurns (${groupSummarize}); OK — group summarizer reads raw transcript`,
    );
  }

  // Advisory: individual summaries should ideally fire before group summaries
  // to provide input to group prompts. Both still work regardless.
  if (
    typeof summarize === "number" &&
    typeof groupSummarize === "number" &&
    summarize >= groupSummarize
  ) {
    log.info(
      `context-decay: summarizeToolResultsAfterTurns (${summarize}) >= summarizeWindowAfterTurns (${groupSummarize}); individual summaries should fire before group summaries`,
    );
  }

  return config;
}

/**
 * Resolve the effective ContextDecayConfig for a session by walking the config hierarchy.
 *
 * Resolution order (most specific wins per field):
 * 1. Per-DM: channels.<provider>.dms.<userId>.contextDecay
 * 2. Per-account/channel: channels.<provider>.contextDecay
 * 3. Global: agents.defaults.contextDecay
 *
 * After resolution, enforces graduated decay ordering: stripToolResultsAfterTurns is
 * auto-clamped to be > summarizeToolResultsAfterTurns so that summarization always
 * has a chance to run before stripping.
 */
export function resolveContextDecayConfig(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): ContextDecayConfig | undefined {
  const globalDecay = config?.agents?.defaults?.contextDecay;

  /** Return global-only config with decay ordering enforced, or undefined. */
  const globalOnly = (): ContextDecayConfig | undefined =>
    globalDecay ? enforceDecayOrdering({ ...globalDecay }) : undefined;

  if (!sessionKey || !config) {
    return globalOnly();
  }

  // Parse session key: "agent:<agentId>:<provider>:<kind>:<userId>" or "<provider>:<kind>:<userId>"
  const parts = sessionKey.split(":");
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) {
    return globalOnly();
  }

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);

  // Resolve provider config from channels
  const channels = config.channels;
  if (!channels || typeof channels !== "object") {
    return globalOnly();
  }

  const providerConfig = (channels as Record<string, unknown>)[provider];
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    return globalOnly();
  }

  const pc = providerConfig as Record<string, unknown>;

  // Layer 1: Per-DM override
  let dmDecay: ContextDecayConfig | undefined;
  if ((kind === "direct" || kind === "dm") && userId) {
    const dms = pc.dms as Record<string, { contextDecay?: ContextDecayConfig }> | undefined;
    dmDecay = dms?.[userId]?.contextDecay;
  }

  // Layer 2: Per-account contextDecay
  const accountDecay = pc.contextDecay as ContextDecayConfig | undefined;

  // Build effective config: global → account → dm (most specific wins)
  let effective = globalDecay;
  effective = mergeDecayConfig(effective, accountDecay);
  effective = mergeDecayConfig(effective, dmDecay);

  return effective ? enforceDecayOrdering(effective) : undefined;
}

/**
 * Check whether the resolved config has any active decay features.
 */
export function isContextDecayActive(config: ContextDecayConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    (typeof config.stripThinkingAfterTurns === "number" && config.stripThinkingAfterTurns >= 1) ||
    (typeof config.summarizeToolResultsAfterTurns === "number" &&
      config.summarizeToolResultsAfterTurns >= 1) ||
    (typeof config.summarizeWindowAfterTurns === "number" &&
      config.summarizeWindowAfterTurns >= 1) ||
    (typeof config.stripToolResultsAfterTurns === "number" &&
      config.stripToolResultsAfterTurns >= 1) ||
    (typeof config.maxContextMessages === "number" && config.maxContextMessages >= 1)
  );
}
