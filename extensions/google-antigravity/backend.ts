import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";

export const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity-cli";
export const GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF =
  "google-antigravity-cli/gemini-3-flash";

export const GOOGLE_ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  flash: "gemini-3-flash",
  pro: "gemini-3-pro-low",
  "pro-low": "gemini-3-pro-low",
  "pro-high": "gemini-3-pro-high",
  "gemini-3-flash": "gemini-3-flash",
  "gemini-3-pro-low": "gemini-3-pro-low",
  "gemini-3-pro-high": "gemini-3-pro-high",
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildGoogleAntigravityCliBackend(
  env: NodeJS.ProcessEnv = process.env,
): CliBackendPlugin {
  return {
    id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    modelProvider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    liveTest: {
      defaultModelRef: GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF,
    },
    nativeToolMode: "always-on",
    prepareExecution: () => {
      const userDataDir = normalizeOptionalString(env.ANTIGRAVITY_USER_DATA_DIR);
      return {
        ...(userDataDir
          ? { env: { ANTIGRAVITY_USER_DATA_DIR: userDataDir } }
          : {}),
        clearEnv: [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_CLOUD_PROJECT_ID",
        ],
      };
    },
    config: {
      command: "agy",
      args: ["--print", "{prompt}", "--print-timeout", "5m0s"],
      output: "text",
      input: "arg",
      maxPromptArgChars: 8000,
      modelArg: "--model",
      modelAliases: GOOGLE_ANTIGRAVITY_MODEL_ALIASES,
      sessionMode: "none",
      reseedFromRawTranscriptWhenUncompacted: true,
      serialize: true,
    },
  };
}
