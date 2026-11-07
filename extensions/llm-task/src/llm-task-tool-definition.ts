import {
  optionalFiniteNumberSchema,
  optionalPositiveIntegerSchema,
} from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export const llmTaskToolDefinition = {
  name: "llm-task",
  label: "LLM Task",
  description:
    "Run a JSON-only LLM task, or a bounded batch of independent inputs, and return schema-validated results. Batch failures are returned per item; the batch scheduler adds no retries.",
  parameters: Type.Object({
    prompt: Type.String({ description: "Task instruction for the LLM." }),
    input: Type.Optional(Type.Unknown({ description: "Optional input payload for the task." })),
    batch: Type.Optional(
      Type.Object({
        items: Type.Array(
          Type.Object({
            id: Type.String({ minLength: 1, maxLength: 64 }),
            input: Type.Unknown(),
          }),
          {
            minItems: 1,
            maxItems: 20,
            description:
              "Independent inputs with unique nonblank IDs. Cannot be combined with input.",
          },
        ),
        concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, default: 2 })),
      }),
    ),
    schema: Type.Optional(
      Type.Unknown({
        description: "Optional JSON Schema to constrain and validate the returned JSON.",
      }),
    ),
    provider: Type.Optional(
      Type.String({ description: "Provider override (e.g. openai, anthropic)." }),
    ),
    model: Type.Optional(Type.String({ description: "Model id override." })),
    thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
    authProfileId: Type.Optional(Type.String({ description: "Auth profile override." })),
    temperature: optionalFiniteNumberSchema({ description: "Best-effort temperature override." }),
    maxTokens: optionalPositiveIntegerSchema({
      description: "Best-effort maxTokens override.",
    }),
    timeoutMs: optionalPositiveIntegerSchema({
      description: "Timeout for the single run or entire batch, including queued items.",
    }),
  }),
};
