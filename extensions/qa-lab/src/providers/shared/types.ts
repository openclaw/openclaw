import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { QaThinkingLevel } from "../../qa-thinking.js";
import type { QaTerminalRequesterSettlement } from "../mock-openai/terminal-requester-settlement.js";
import type { MockProviderVariant } from "./mock-provider-variant.js";

export type QaProviderMode = "mock-openai" | "aimock" | "live-frontier";
export type QaProviderModeInput = QaProviderMode;

export type QaMockRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  toolOutput: string;
  model: string;
  providerVariant: MockProviderVariant;
  imageInputCount: number;
  plannedToolCallId?: string;
  plannedToolName?: string;
  toolOutputCallId?: string;
  toolOutputStructuredError?: true;
};

/** Provider observation only; Gateway run/receipt identity must be collected separately. */
export type QaMockContinuationCheckpoint = Readonly<{
  cursor: number;
  sessionId: string;
  toolOutputCallId: string;
}>;

export type QaMockContinuationHold = {
  reached: Promise<QaMockContinuationCheckpoint>;
  release(): void;
  cancel(): void;
};

export type QaMockProviderServer = {
  baseUrl: string;
  sessionObserverUrl?: string;
  terminalRequesters?: QaTerminalRequesterSettlement;
  holdNextContinuation?: (sessionId: string, signal: AbortSignal) => QaMockContinuationHold;
  stop(): Promise<void>;
};

type QaProviderModelParamsInput = {
  modelRef: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
};

type QaProviderGatewayModelsInput = {
  providerBaseUrl: string;
  primaryModel?: string;
  alternateModel?: string;
  liveProviderConfigs?: Record<string, ModelProviderConfig>;
};

type QaProviderTurnTimeoutInput = {
  modelRef: string;
  fallbackMs: number;
};

export type QaProviderDefinition = {
  mode: QaProviderMode;
  kind: "mock" | "live";
  standaloneCommand?: {
    name: string;
    description: string;
    serverLabel: string;
  };
  defaultModel(options?: { alternate?: boolean; preferredLiveModel?: string }): string;
  usesFastModeByDefault(modelRef: string): boolean;
  resolveModelParams(input: QaProviderModelParamsInput): Record<string, unknown>;
  resolveTurnTimeoutMs(input: QaProviderTurnTimeoutInput): number;
  buildGatewayModels(input: QaProviderGatewayModelsInput): {
    mode: "replace" | "merge";
    providers: Record<string, ModelProviderConfig>;
  } | null;
  mockAuthProviders?: readonly string[];
};
