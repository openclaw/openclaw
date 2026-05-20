/**
 * Model tier system for Wired Wisdom AI / Mission Control.
 *
 * Provides a 3-tier model switching system (Economy / Executive / Einstein).
 * NOTE: the internal identifier for the mid tier is still `"baller"` — kept
 * for backwards compatibility with saved `model-tiers.json` files. Only the
 * user-visible label says "Executive Mode".
 * with global defaults and per-agent overrides.
 *
 * Tier state is stored in ~/.openclaw/model-tiers.json (separate from
 * openclaw.json to avoid schema validation conflicts).
 *
 * When tiers change, the gateway handler also patches agents.defaults.model
 * and per-agent model overrides in openclaw.json so the existing model
 * resolution chain picks up the change.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeBrainTierConfigParts,
  resolveBrainProfileForMode,
  type BrainProfile,
} from "./brain-profiles.js";

export type ModelTierMode = "economy" | "baller" | "einstein";

export type ModelTierConfig = {
  globalMode: ModelTierMode;
  agentOverrides: Record<string, ModelTierMode>;
  tierRouting: Required<Record<ModelTierMode, string>>;
  brainProfiles: Record<string, BrainProfile>;
};

/** Legacy fallback map used when model-tiers.json has no tierRouting. */
export const MODEL_TIER_MAP: Record<ModelTierMode, string> = {
  economy: "claude-haiku-4-5-20251001",
  baller: "claude-sonnet-4-6",
  einstein: "claude-opus-4-6",
};

/** Reverse map: model string → tier mode */
export const MODEL_TO_TIER: Record<string, ModelTierMode> = {
  "claude-haiku-4-5-20251001": "economy",
  "claude-sonnet-4-6": "baller",
  "claude-opus-4-6": "einstein",
};

export const MODEL_TIER_LABELS: Record<ModelTierMode, string> = {
  economy: "Economy Mode",
  baller: "Executive Mode",
  einstein: "Einstein Mode",
};

export const MODEL_TIER_COST: Record<ModelTierMode, string> = {
  economy: "$",
  baller: "$$",
  einstein: "$$$$",
};

export const MODEL_TIER_COLORS: Record<ModelTierMode, string> = {
  economy: "#4CAF50",
  baller: "#0A9EFC",
  einstein: "#9C27B0",
};

const VALID_MODES = new Set<string>(["economy", "baller", "einstein"]);

export function isValidModelTierMode(value: unknown): value is ModelTierMode {
  return typeof value === "string" && VALID_MODES.has(value);
}

function tierFilePath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "model-tiers.json");
}

/**
 * Read model tier config from the tier state file.
 * Falls back to economy mode if file doesn't exist.
 */
export function loadModelTierConfig(): ModelTierConfig {
  try {
    const filePath = tierFilePath();
    if (!fs.existsSync(filePath)) {
      return normalizeBrainTierConfigParts({});
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const globalMode = isValidModelTierMode(raw.globalMode) ? raw.globalMode : "economy";
    const rawOverrides =
      raw.agentOverrides && typeof raw.agentOverrides === "object"
        ? (raw.agentOverrides as Record<string, unknown>)
        : {};
    const agentOverrides: Record<string, ModelTierMode> = {};
    for (const [agentId, mode] of Object.entries(rawOverrides)) {
      if (isValidModelTierMode(mode)) {
        agentOverrides[agentId] = mode;
      }
    }
    return normalizeBrainTierConfigParts({
      globalMode,
      agentOverrides,
      tierRouting:
        raw.tierRouting && typeof raw.tierRouting === "object"
          ? (raw.tierRouting as Record<string, unknown>)
          : undefined,
      brainProfiles:
        raw.brainProfiles && typeof raw.brainProfiles === "object"
          ? (raw.brainProfiles as Record<string, unknown>)
          : undefined,
    });
  } catch {
    return normalizeBrainTierConfigParts({});
  }
}

/**
 * Write model tier config to the tier state file.
 */
export function saveModelTierConfig(config: ModelTierConfig): void {
  const filePath = tierFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get the full provider/model string for a tier mode.
 */
export function getProviderModelForTier(
  mode: ModelTierMode,
  config = loadModelTierConfig(),
): string {
  return resolveBrainProfileForMode(config, mode).modelRef;
}
