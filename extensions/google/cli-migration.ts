import {
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { readGeminiCliCredentialsForSetup } from "./cli-auth-seam.js";

export const GEMINI_CLI_BACKEND_ID = "google-gemini-cli";
export const GEMINI_CLI_DEFAULT_MODEL_REF = `${GEMINI_CLI_BACKEND_ID}/gemini-3-flash-preview`;
export const GEMINI_CLI_DEFAULT_ALLOWLIST_REFS = [
  GEMINI_CLI_DEFAULT_MODEL_REF,
  `${GEMINI_CLI_BACKEND_ID}/gemini-3-pro-preview`,
  `${GEMINI_CLI_BACKEND_ID}/gemini-3.1-pro-preview`,
  `${GEMINI_CLI_BACKEND_ID}/gemini-3.1-flash-preview`,
  `${GEMINI_CLI_BACKEND_ID}/gemini-3.1-flash-lite-preview`,
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

export function isGeminiCliProviderRef(ref: unknown): boolean {
  if (typeof ref !== "string") {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(ref);
  return lower.startsWith(`${GEMINI_CLI_BACKEND_ID}/`);
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
