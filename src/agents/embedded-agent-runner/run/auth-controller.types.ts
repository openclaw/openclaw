import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { Model } from "../../../llm/types.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { RuntimeAuthState } from "./helpers.js";
import type { resolveEmbeddedRunEffectiveModel } from "./model-harness.js";

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

export type RuntimeApiKeySink = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

export type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};
