import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { Model } from "../../../llm/types.js";
import type { ProviderModelRouteAuthRequirement } from "../../../plugin-sdk/provider-model-types.js";
import type { CommandQueueTaskDeadline } from "../../../process/command-queue.types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
import type { RuntimeAuthState } from "./helpers.js";
import type { resolveEmbeddedRunEffectiveModel } from "./model-harness.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export type EmbeddedRunAuthState = {
  readonly models: {
    runtime: Model;
    effective: ReturnType<typeof resolveEmbeddedRunEffectiveModel>["effectiveModel"];
  };
  apiKeyInfo: ResolvedProviderAuth | null;
  lastProfileId: string | undefined;
  runtimeAuthState: RuntimeAuthState | null;
  runtimeAuthRefreshCancelled: boolean;
  profileIndex: number;
  thinkLevel: ThinkLevel;
};

export type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

export type EmbeddedRunAuthControllerParams = {
  authProfileBinding?: RunEmbeddedAgentParams["authProfileBinding"];
  config: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  authStorage: { setRuntimeApiKey(provider: string, apiKey: string): void };
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  initialThinkLevel: ThinkLevel;
  attemptedThinking: Set<ThinkLevel>;
  fallbackConfigured: boolean;
  allowTransientCooldownProbe: boolean;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  authProfileStateMode?: "read-write" | "read-only";
  runId?: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  getDeadline?: () => CommandQueueTaskDeadline | undefined;
  provider: string;
  modelId: string;
  state: EmbeddedRunAuthState;
  prepareModelForAuthProfile?(
    profileId: string | undefined,
    attemptIndex?: number,
  ): Promise<{
    runtimeModel: Model;
    authRequirement?: ProviderModelRouteAuthRequirement;
    allowAuthProfileFallback?: boolean;
    commit(): void;
  }>;
  log: LogLike;
};
