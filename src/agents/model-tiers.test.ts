import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProviderModelForTier,
  loadModelTierConfig,
  saveModelTierConfig,
} from "./model-tiers.js";

let tempStateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-tiers-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  fs.rmSync(tempStateDir, { recursive: true, force: true });
});

function writeTierFile(value: unknown): void {
  fs.writeFileSync(path.join(tempStateDir, "model-tiers.json"), JSON.stringify(value, null, 2));
}

describe("model tier config", () => {
  it("loads missing config as legacy-compatible economy mode", () => {
    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("economy");
    expect(config.agentOverrides).toEqual({});
    expect(config.tierRouting.economy).toBe("legacy-anthropic-haiku");
    expect(getProviderModelForTier("economy", config)).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
  });

  it("loads new tierRouting and brainProfiles", () => {
    writeTierFile({
      globalMode: "einstein",
      agentOverrides: { quinn: "baller" },
      tierRouting: {
        economy: "openai-api-cheap",
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
      brainProfiles: {},
    });

    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("einstein");
    expect(config.agentOverrides).toEqual({ quinn: "baller" });
    expect(getProviderModelForTier("einstein", config)).toBe("openai-codex/gpt-5.5");
    expect(getProviderModelForTier("baller", config)).toBe("openai/gpt-5.4");
  });

  it("drops invalid modes, invalid overrides, and invalid profile references", () => {
    writeTierFile({
      globalMode: "not-real",
      agentOverrides: { quinn: "einstein", bad: "opus" },
      tierRouting: { einstein: "missing-profile" },
    });

    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("economy");
    expect(config.agentOverrides).toEqual({ quinn: "einstein" });
    expect(config.tierRouting.einstein).toBe("legacy-anthropic-opus");
  });

  it("saves normalized config with provider-neutral fields", () => {
    const config = loadModelTierConfig();
    config.globalMode = "einstein";
    config.tierRouting.einstein = "openai-codex-subscription-best";
    saveModelTierConfig(config);

    const raw = JSON.parse(fs.readFileSync(path.join(tempStateDir, "model-tiers.json"), "utf-8"));
    expect(raw.globalMode).toBe("einstein");
    expect(raw.tierRouting.einstein).toBe("openai-codex-subscription-best");
    expect(raw.brainProfiles["openai-codex-subscription-best"].modelRef).toBe(
      "openai-codex/gpt-5.5",
    );
  });
});
