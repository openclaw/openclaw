import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { WorkerExecutionModeSchema } from "./environments.js";
import { NonEmptyString } from "./primitives.js";

/** Model option shown in selectors and model catalog results. */
export const GatewayAgentRuntimeSchema = closedObject({
  id: NonEmptyString,
  fallback: Type.Optional(Type.Union([Type.Literal("openclaw"), Type.Literal("none")])),
  cloudPlacementSupported: Type.Optional(Type.Boolean()),
  cloudPlacementExecutionMode: Type.Optional(WorkerExecutionModeSchema),
  devicePlacement: Type.Optional(
    closedObject({
      requiredNodeCommands: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
        uniqueItems: true,
      }),
      consumesWorkerSlot: Type.Boolean(),
    }),
  ),
  devicePlacementSupported: Type.Optional(Type.Boolean()),
  source: Type.Union([
    Type.Literal("env"),
    Type.Literal("agent"),
    Type.Literal("defaults"),
    Type.Literal("model"),
    Type.Literal("provider"),
    Type.Literal("implicit"),
    Type.Literal("session"),
    Type.Literal("session-key"),
  ]),
});

export const GatewayThinkingLevelOptionSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
});

const GatewayContextWindowOptionSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  contextWindow: Type.Integer({ minimum: 1 }),
});

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
