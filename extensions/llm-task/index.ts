// Llm Task plugin entrypoint registers its OpenClaw integration.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { AnyAgentTool } from "./api.js";
import { createLlmTaskTool, llmTaskToolDefinition } from "./src/llm-task-tool.js";

const llmTaskConfigSchema = Type.Object(
  {
    defaultProvider: Type.Optional(Type.String()),
    defaultModel: Type.Optional(Type.String()),
    defaultAuthProfileId: Type.Optional(Type.String()),
    allowedModels: Type.Optional(
      Type.Array(Type.String(), {
        description: "Allowlist of provider/model keys like openai/gpt-5.6-sol.",
      }),
    ),
    maxTokens: optionalPositiveIntegerSchema(),
    timeoutMs: optionalPositiveIntegerSchema(),
  },
  { additionalProperties: false },
) as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0];

export default definePluginEntry({
  id: "llm-task",
  name: "LLM Task",
  description: "Generic JSON-only LLM tool for structured tasks callable from workflows.",
  configSchema: buildJsonPluginConfigSchema(llmTaskConfigSchema),
  register(api) {
    api.registerTool(createLlmTaskTool(api) as unknown as AnyAgentTool, {
      name: llmTaskToolDefinition.name,
      optional: true,
    });
  },
});
