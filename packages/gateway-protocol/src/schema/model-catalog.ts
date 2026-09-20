import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ChatAccountSelectionSchema } from "./model-account-selection.js";
import {
  GatewayAgentRuntimeSchema,
  GatewayContextWindowOptionSchema,
  GatewayThinkingLevelOptionSchema,
} from "./model-runtime-options.js";
import { NonEmptyString } from "./primitives.js";

const ModelUnavailableReasonSchema = Type.Union([
  Type.Literal("missing-auth"),
  Type.Literal("auth-failed"),
  Type.Literal("cooldown"),
]);

const ModelRuntimeProperties = {
  available: Type.Optional(Type.Boolean()),
  /** Scoped manual-choice permission; separate from runtime readiness and automatic selection. */
  manualSelectionAllowed: Type.Optional(Type.Boolean()),
  unavailableReason: Type.Optional(ModelUnavailableReasonSchema),
  /** Earliest known retry time in epoch milliseconds, only for unavailable models. */
  unavailableUntil: Type.Optional(Type.Integer({ minimum: 0 })),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  contextTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  local: Type.Optional(Type.Boolean()),
  contextWindows: Type.Optional(Type.Array(GatewayContextWindowOptionSchema)),
  contextWindowDefault: Type.Optional(NonEmptyString),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
  thinkingDefault: Type.Optional(NonEmptyString),
  effectiveFastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  /** Local selected-request applicability, not preference or upstream fulfillment. */
  supportsFastMode: Type.Optional(Type.Boolean()),
  supportsTools: Type.Optional(Type.Boolean()),
  input: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("image"),
        Type.Literal("audio"),
        Type.Literal("video"),
        Type.Literal("document"),
      ]),
    ),
  ),
};

/** Runtime-specific capabilities for an additional choice of the same canonical model. */
export const ModelRuntimeChoiceSchema = closedObject({
  agentRuntime: GatewayAgentRuntimeSchema,
  ...ModelRuntimeProperties,
  unavailableReason: Type.Optional(
    Type.Union([ModelUnavailableReasonSchema, Type.Literal("unsupported-runtime")]),
  ),
});

export const ModelChoiceSchema = closedObject({
  id: NonEmptyString,
  name: NonEmptyString,
  provider: NonEmptyString,
  alias: Type.Optional(NonEmptyString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  ...ModelRuntimeProperties,
  agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
  apiKeySupported: Type.Optional(Type.Boolean()),
  runtimeChoices: Type.Optional(Type.Array(ModelRuntimeChoiceSchema, { maxItems: 8 })),
});

/** Model catalog result. */
export const ModelCatalogProviderOutcomeSchema = closedObject({
  provider: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  status: Type.Union([
    Type.Literal("ready"),
    Type.Literal("auth-rejected"),
    Type.Literal("unavailable"),
  ]),
});

export const ModelsListResultSchema = closedObject({
  models: Type.Array(ModelChoiceSchema),
  /** Manifest-owned decision choices, separate from conversational model routing. */
  decisionModels: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        provider: NonEmptyString,
        name: NonEmptyString,
        pluginId: NonEmptyString,
      }),
    ),
  ),
  defaultModels: Type.Optional(
    closedObject({
      /** Auto preview from agents.defaults.model, even when utility routing is explicit or disabled. */
      automaticUtilityModel: Type.Union([NonEmptyString, Type.Null()]),
    }),
  ),
  refreshFailed: Type.Optional(Type.Boolean()),
  pendingProviders: Type.Optional(Type.Array(NonEmptyString)),
  accountSelection: Type.Optional(ChatAccountSelectionSchema),
  providerOutcomes: Type.Optional(Type.Array(ModelCatalogProviderOutcomeSchema)),
});

export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelRuntimeChoice = Static<typeof ModelRuntimeChoiceSchema>;
export type ModelCatalogProviderOutcome = Static<typeof ModelCatalogProviderOutcomeSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
