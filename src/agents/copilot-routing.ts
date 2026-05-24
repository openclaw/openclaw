import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseModelRefProvider } from "./openai-codex-routing.js";

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

/**
 * Returns true when the selected model should trigger the on-demand
 * install of `@github/copilot-sdk` for the Copilot agent runtime.
 *
 * Mirrors `modelSelectionShouldEnsureCodexPlugin` (see
 * `src/agents/openai-codex-routing.ts`) but for the copilot agent
 * runtime, which only fires for `github-copilot/*` model refs (the
 * Copilot SDK isn't used for any other provider).
 */
export function modelSelectionShouldEnsureCopilotSdk(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  // The config argument is reserved for future routing decisions (e.g.
  // BYOK profiles that explicitly route copilot models elsewhere). It is
  // intentionally unused today to keep the contract symmetric with
  // `modelSelectionShouldEnsureCodexPlugin`.
  void params.config;
  return parseModelRefProvider(params.model) === GITHUB_COPILOT_PROVIDER_ID;
}
