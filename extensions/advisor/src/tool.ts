// Advisor tool: wraps api.runtime.llm.complete to provide a model-agnostic second opinion.
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";

const AdvisorToolSchema = Type.Object({
  question: Type.String({
    description:
      "The question, problem, or decision to get expert review on. Include all relevant context inline — the advisor only sees what you pass here, not the surrounding conversation.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Additional background context, code snippets, relevant constraints, or prior conclusions that the advisor needs to give a useful answer.",
    }),
  ),
});

type AdvisorParams = Static<typeof AdvisorToolSchema>;

const ADVISOR_SYSTEM_PROMPT = `You are a senior expert advisor providing a second opinion during an AI agent session.

Your role:
- Catch errors, oversights, or unsafe assumptions in the proposed approach
- Suggest concrete improvements or alternatives where relevant
- Flag potential side effects, edge cases, or risks
- Be direct, specific, and concise — prioritize the highest-impact insights
- If the approach looks solid, say so briefly with the key reason why

Respond in plain text. No pleasantries — focus on substance.`;

export function createAdvisorTool(
  ctx: OpenClawPluginToolContext,
  api: OpenClawPluginApi,
): AnyAgentTool {
  const configuredModelRef =
    typeof api.pluginConfig?.modelRef === "string" ? api.pluginConfig.modelRef : undefined;

  const modelLabel = configuredModelRef
    ? `configured advisor model (${configuredModelRef})`
    : "the agent's active model";

  return {
    name: "advisor",
    label: "Advisor",
    description: `Get an expert second opinion from ${modelLabel}.

Use this tool when you need to:
- Verify a complex plan before executing it
- Check whether your solution correctly handles edge cases
- Get a second read on ambiguous requirements or design tradeoffs
- Catch potential errors or security issues in a proposed implementation

Pass rich context in \`question\` — the advisor only sees what you provide here.${
      configuredModelRef
        ? `\n\nNote: requires \`plugins.entries.advisor.llm.allowModelOverride: true\` in agent config to use the override model.`
        : ""
    }`,
    parameters: AdvisorToolSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as AdvisorParams;
      const userContent = params.context
        ? `${params.context}\n\n---\n\n${params.question}`
        : params.question;

      const result = await api.runtime.llm.complete({
        messages: [{ role: "user", content: userContent }],
        systemPrompt: ADVISOR_SYSTEM_PROMPT,
        ...(configuredModelRef ? { model: configuredModelRef } : {}),
        agentId: ctx.agentId,
        signal,
        purpose: "advisor",
      });

      const attribution = `[Advisor: ${result.provider}/${result.model}]`;
      return {
        content: [{ type: "text" as const, text: `${result.text}\n\n${attribution}` }],
        details: {
          provider: result.provider,
          model: result.model,
          usage: result.usage,
        },
      };
    },
  } satisfies AnyAgentTool;
}
