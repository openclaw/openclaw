// Google module owns Gemini CLI harness opt-in policy.

export const GOOGLE_GEMINI_CLI_HARNESS_ENV = "OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

type HarnessEnv = Record<string, string | undefined>;

export function shouldEnableGoogleGeminiCliHarness(env: HarnessEnv = process.env): boolean {
  const value = env[GOOGLE_GEMINI_CLI_HARNESS_ENV];
  return typeof value === "string" && ENABLED_VALUES.has(value.trim().toLowerCase());
}
