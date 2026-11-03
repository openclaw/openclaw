import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { llmTaskToolDefinition } from "./src/llm-task-tool-definition.js";

export default defineToolPlugin({
  id: "llm-task",
  name: "LLM Task",
  description: "Generic JSON-only LLM tool for structured tasks callable from workflows.",
  configSchema: Type.Object(
    {
      defaultProvider: Type.Optional(Type.String()),
      defaultModel: Type.Optional(Type.String()),
      defaultAuthProfileId: Type.Optional(Type.String()),
      maxTokens: optionalPositiveIntegerSchema(),
      timeoutMs: optionalPositiveIntegerSchema(),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      ...llmTaskToolDefinition,
      optional: true,
      factory: ({ api }) => {
        // Tool catalog and registration need only metadata; model/schema runtimes load on first use.
        const loadTool = createLazyRuntimeModule(() =>
          import("./src/llm-task-tool.js").then(({ createLlmTaskTool }) => createLlmTaskTool(api)),
        );
        return {
          ...llmTaskToolDefinition,
          execute: async (id, params, signal) =>
            await (await loadTool()).execute(id, params, signal),
        };
      },
    }),
  ],
});
