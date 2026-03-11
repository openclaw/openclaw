import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import {
  normalizeGeneratedThreadTitle,
  resolveDiscordThreadTitleModelSelection,
} from "./thread-title.js";

describe("resolveDiscordThreadTitleModelSelection", () => {
  it("preserves multi-segment model ids (openrouter provider models)", () => {
    const cfg = {
      agents: {
        defaults: { model: "openrouter/anthropic/claude-sonnet-4-5" },
      },
    } as OpenClawConfig;

    const selection = resolveDiscordThreadTitleModelSelection({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
      }),
    );
  });

  it("uses the routed agent model override when present", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
        list: [{ id: "ops", model: "openrouter/aurora-alpha" }],
      },
    } as OpenClawConfig;

    const selection = resolveDiscordThreadTitleModelSelection({ cfg, agentId: "ops" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "openrouter/aurora-alpha",
      }),
    );
  });

  it("keeps trailing auth profile for credential lookup", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6@work" },
      },
    } as OpenClawConfig;

    const selection = resolveDiscordThreadTitleModelSelection({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        profileId: "work",
      }),
    );
  });
});

describe("normalizeGeneratedThreadTitle", () => {
  it("strips quotes and keeps the first non-empty line", () => {
    expect(normalizeGeneratedThreadTitle(' "Weekly Release Summary"\nExtra text')).toBe(
      "Weekly Release Summary",
    );
  });

  it("skips leading blank lines before selecting a title", () => {
    expect(normalizeGeneratedThreadTitle('\n\n "Weekly Release Summary"\nExtra text')).toBe(
      "Weekly Release Summary",
    );
  });

  it("skips leading markdown fence lines before selecting a title", () => {
    expect(normalizeGeneratedThreadTitle("```markdown\nWeekly Release Summary\n```")).toBe(
      "Weekly Release Summary",
    );
  });
});
