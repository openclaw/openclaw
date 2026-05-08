import { describe, expect, it } from "vitest";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";

describe("buildGithubCopilotReplayPolicy", () => {
  describe("Claude family (anthropic-messages)", () => {
    it("drops legacy thinking blocks for claude models", () => {
      const policy = buildGithubCopilotReplayPolicy("claude-opus-4.5");
      expect(policy).toMatchObject({ dropThinkingBlocks: true });
      // Must NOT also flip the Responses-side flag — Anthropic transport doesn't
      // need it and merging both could obscure regressions.
      expect(policy).not.toHaveProperty("dropReasoningFromHistory");
    });

    it("matches claude regardless of casing", () => {
      const policy = buildGithubCopilotReplayPolicy("Claude-Sonnet-4.5");
      expect(policy).toMatchObject({ dropThinkingBlocks: true });
    });
  });

  describe("GPT / o-series family (openai-responses) — issue #78867", () => {
    // Regression: Copilot routes non-Claude models to openai-responses and
    // rejects replayed `encrypted_content` from prior turns with
    // `400 The encrypted content for item rs_<id> could not be verified`.
    // The replay policy must drop reasoning from history without disabling
    // reasoning entirely (which was the only bypass before this fix).

    it("drops reasoning from history for gpt-5.5", () => {
      const policy = buildGithubCopilotReplayPolicy("gpt-5.5");
      expect(policy).toMatchObject({ dropReasoningFromHistory: true });
      // dropThinkingBlocks would also wipe the *current* assistant turn's
      // thinking, breaking o-series multi-step tool flows. Use the
      // history-only variant.
      expect(policy).not.toHaveProperty("dropThinkingBlocks");
    });

    it("drops reasoning from history for gpt-5.4 / 5.3-codex / gpt-5.2", () => {
      for (const modelId of ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.4-mini"]) {
        const policy = buildGithubCopilotReplayPolicy(modelId);
        expect(policy, `model ${modelId}`).toMatchObject({ dropReasoningFromHistory: true });
      }
    });

    it("drops reasoning from history for o-series and synthetic gpt model ids", () => {
      // Catch-all for unknown models the user adds to agents.defaults.models.
      // resolveCopilotForwardCompatModel() picks openai-responses for any
      // non-claude id, so any non-claude model id should get the same policy.
      for (const modelId of ["o3-mini", "o1", "raptor-mini", "goldeneye", "gemini-3.1-pro"]) {
        const policy = buildGithubCopilotReplayPolicy(modelId);
        expect(policy, `model ${modelId}`).toMatchObject({ dropReasoningFromHistory: true });
      }
    });

    it("falls back to drop-from-history when modelId is missing", () => {
      // Defensive: with no model id we can't tell, but the safer default is to
      // protect against the encrypted_content replay regression rather than
      // pass through unknown reasoning items.
      const policy = buildGithubCopilotReplayPolicy(undefined);
      expect(policy).toMatchObject({ dropReasoningFromHistory: true });
    });
  });
});
