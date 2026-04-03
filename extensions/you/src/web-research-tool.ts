import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { isValidResearchEffort, runYouResearch, type ResearchEffort } from "./you-client.js";

const RESEARCH_EFFORTS = ["lite", "standard", "deep", "exhaustive"] as const;

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...options,
    }),
  );
}

const YouResearchSchema = Type.Object(
  {
    input: Type.String({
      description:
        "The research question or complex query requiring in-depth investigation and multi-step reasoning (max 40,000 chars).",
    }),
    research_effort: optionalStringEnum(RESEARCH_EFFORTS, {
      description:
        'Controls research depth. "lite" = fast answers (<2s), "standard" = balanced (10-30s, default), "deep" = thorough (<120s), "exhaustive" = most comprehensive (<300s).',
    }),
  },
  { additionalProperties: false },
);

export function createWebResearchTool(api: OpenClawPluginApi) {
  return {
    name: "web_research",
    label: "Web Research",
    description:
      "Deep web research on complex queries. Returns comprehensive, cited Markdown answers from multi-step web investigation. Use for questions that need thorough research rather than a simple search. Requires YDC_API_KEY.",
    parameters: YouResearchSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const input = readStringParam(rawParams, "input", { required: true });
      const rawEffort = readStringParam(rawParams, "research_effort") || "standard";
      const effort: ResearchEffort = isValidResearchEffort(rawEffort) ? rawEffort : "standard";

      return jsonResult(
        await runYouResearch({
          cfg: api.config,
          input,
          researchEffort: effort,
        }),
      );
    },
  };
}
