// Gateway Protocol schema module defines ephemeral follow-up task suggestions.
import { Type } from "typebox";

const TaskIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const TaskTitleSchema = Type.String({ minLength: 1, maxLength: 60 });
const TaskPromptSchema = Type.String({ minLength: 1, maxLength: 32_768 });
const TaskTldrSchema = Type.String({ minLength: 1, maxLength: 1_024 });
const TaskCwdSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const TaskSessionKeySchema = Type.String({ minLength: 1, maxLength: 512 });
const TaskAgentIdSchema = Type.String({ minLength: 1, maxLength: 128 });

/** One model-proposed follow-up task waiting for operator action. */
export const TaskSuggestionSchema = Type.Object(
  {
    id: TaskIdSchema,
    title: TaskTitleSchema,
    prompt: TaskPromptSchema,
    tldr: TaskTldrSchema,
    cwd: TaskCwdSchema,
    sessionKey: TaskSessionKeySchema,
    agentId: Type.Optional(TaskAgentIdSchema),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Lists pending suggestions, optionally narrowed to one source session. */
export const TaskSuggestionsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(TaskSessionKeySchema),
    agentId: Type.Optional(TaskAgentIdSchema),
  },
  { additionalProperties: false },
);

export const TaskSuggestionsListResultSchema = Type.Object(
  { suggestions: Type.Array(TaskSuggestionSchema) },
  { additionalProperties: false },
);

/** Creates a pending suggestion without starting any work. */
export const TaskSuggestionsCreateParamsSchema = Type.Object(
  {
    title: TaskTitleSchema,
    prompt: TaskPromptSchema,
    tldr: TaskTldrSchema,
    cwd: TaskCwdSchema,
    sessionKey: TaskSessionKeySchema,
    agentId: Type.Optional(TaskAgentIdSchema),
  },
  { additionalProperties: false },
);

export const TaskSuggestionsCreateResultSchema = Type.Object(
  { taskId: TaskIdSchema, suggestion: TaskSuggestionSchema },
  { additionalProperties: false },
);

export const TaskSuggestionResolutionSchema = Type.Union([
  Type.Literal("dismissed"),
  Type.Literal("accepted"),
  Type.Literal("expired"),
]);

/** Atomically claims a pending suggestion and starts its server-owned worktree session. */
export const TaskSuggestionsAcceptParamsSchema = Type.Object(
  { taskId: TaskIdSchema },
  { additionalProperties: false },
);

export const TaskSuggestionsAcceptResultSchema = Type.Object(
  { taskId: TaskIdSchema, key: TaskSessionKeySchema },
  { additionalProperties: false },
);

/** Removes a pending suggestion without starting work. */
export const TaskSuggestionsDismissParamsSchema = Type.Object(
  {
    taskId: TaskIdSchema,
    reason: Type.Optional(Type.String({ maxLength: 1_024 })),
  },
  { additionalProperties: false },
);

export const TaskSuggestionsDismissResultSchema = Type.Object(
  { taskId: TaskIdSchema, dismissed: Type.Boolean() },
  { additionalProperties: false },
);

/** Live update emitted when a pending suggestion is created or resolved. */
export const TaskSuggestionEventSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("created"), suggestion: TaskSuggestionSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("resolved"),
      taskId: TaskIdSchema,
      resolution: TaskSuggestionResolutionSchema,
    },
    { additionalProperties: false },
  ),
]);
