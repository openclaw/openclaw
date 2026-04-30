import {
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { readGeminiCliCredentialsForSetup } from "./cli-auth-seam.js";

export const GEMINI_CLI_BACKEND_ID = "google-gemini-cli";
// Canonical `google/*` model refs. The Gemini CLI runtime is selected separately
// through `agents.defaults.agentRuntime.id = "google-gemini-cli"` so onboarding
// stays on the same model-ref contract as API-key and OAuth setups.
export const GEMINI_CLI_DEFAULT_MODEL_REF = "google/gemini-3.1-pro-preview";
export const GEMINI_CLI_DEFAULT_ALLOWLIST_REFS = [
  GEMINI_CLI_DEFAULT_MODEL_REF,
  "google/gemini-3.1-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash-preview",
] as const;

type AgentDefaultsModels = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
type AgentDefaultsRuntimePolicy = NonNullable<
  NonNullable<OpenClawConfig["agents"]>["defaults"]
>["agentRuntime"];
type GeminiCliCredential = NonNullable<ReturnType<typeof readGeminiCliCredentialsForSetup>>;

function seedGeminiCliAllowlist(
  models: NonNullable<AgentDefaultsModels>,
): NonNullable<AgentDefaultsModels> {
  const next = { ...models };
  for (const ref of GEMINI_CLI_DEFAULT_ALLOWLIST_REFS) {
    next[ref] = next[ref] ?? {};
  }
  return next;
}

function selectGeminiCliRuntime(agentRuntime: AgentDefaultsRuntimePolicy | undefined) {
  const currentRuntime = agentRuntime?.id?.trim();
  if (currentRuntime && currentRuntime !== "auto") {
    return agentRuntime;
  }
  return {
    ...agentRuntime,
    id: GEMINI_CLI_BACKEND_ID,
  };
}

export function hasGeminiCliAuth(): boolean {
  return Boolean(readGeminiCliCredentialsForSetup());
}

export function buildGoogleGeminiCliMigrationResult(
  config: OpenClawConfig,
  credential?: GeminiCliCredential | null,
): ProviderAuthResult {
  void credential;
  const defaults = config.agents?.defaults;
  const existingModels = (defaults?.models ?? {}) as NonNullable<AgentDefaultsModels>;
  const nextModels = seedGeminiCliAllowlist(existingModels);
  const defaultModel = GEMINI_CLI_DEFAULT_MODEL_REF;

  return {
    profiles: [],
    configPatch: {
      agents: {
        defaults: {
          agentRuntime: selectGeminiCliRuntime(defaults?.agentRuntime),
          models: nextModels,
        },
      },
    },
    defaultModel,
    notes: [
      "Gemini CLI auth detected; selected the local Gemini CLI runtime.",
      "Existing Google auth profiles are kept for rollback.",
    ],
  };
}
