/**
 * Case-Based Reasoning Tools — S(B,D) = F(Sb ∩ Sd)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

const CbrRetrieveParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  beliefs: Type.Array(Type.String(), {
    description: "Current belief IDs relevant to the situation",
  }),
  desires: Type.Array(Type.String(), { description: "Active desire IDs" }),
  max_results: Type.Optional(Type.Number({ description: "Max cases to return (default: 5)" })),
  include_negative: Type.Optional(
    Type.Boolean({ description: "Include negative (failure) cases" }),
  ),
});

const CbrStoreParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  case_id: Type.String({ description: "Case ID (e.g., 'C-001')" }),
  situation: Type.Object({
    beliefs: Type.Array(Type.String(), { description: "Belief IDs active during this case" }),
    desires: Type.Array(Type.String(), { description: "Desire IDs active during this case" }),
    context: Type.String({ description: "Situation description" }),
  }),
  solution: Type.Object({
    plan_id: Type.String({ description: "Plan used" }),
    actions: Type.Array(Type.String(), { description: "Actions taken" }),
  }),
  outcome: Type.Object({
    success: Type.Boolean({ description: "Whether the outcome was positive" }),
    metrics: Type.Optional(
      Type.Record(Type.String(), Type.Number(), { description: "Outcome metrics" }),
    ),
    lessons: Type.Optional(Type.String({ description: "Lessons learned" })),
  }),
});

export function createCbrTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "cbr_retrieve",
      label: "CBR Retrieve",
      description:
        "Retrieve similar past cases using CBR-BDI algorithm S(B,D) = F(Sb ∩ Sd). Matches current beliefs and desires against stored cases.",
      parameters: CbrRetrieveParams,
      async execute(_id: string, params: Static<typeof CbrRetrieveParams>) {
        const ws = resolveWorkspaceDir(api);
        const casesPath = join(ws, "agents", params.agent_id, "cases.json");
        const cases = await readJson(casesPath);

        if (!cases || !Array.isArray(cases) || cases.length === 0) {
          return textResult(
            `No cases stored for agent '${params.agent_id}'. The case base is empty.`,
          );
        }

        const maxResults = params.max_results || 5;
        const beliefSet = new Set(params.beliefs);
        const desireSet = new Set(params.desires);

        // CBR-BDI retrieval: S(B,D) = F(Sb ∩ Sd)
        const scored = cases
          .filter((c: any) => params.include_negative || c.outcome?.success !== false)
          .map((c: any) => {
            const sb = (c.situation?.beliefs || []).filter((b: string) => beliefSet.has(b)).length;
            const sd = (c.situation?.desires || []).filter((d: string) => desireSet.has(d)).length;
            const totalB = Math.max(c.situation?.beliefs?.length || 1, 1);
            const totalD = Math.max(c.situation?.desires?.length || 1, 1);
            const score = (sb / totalB) * 0.6 + (sd / totalD) * 0.4;
            return { ...c, _score: score };
          })
          .sort((a: any, b: any) => b._score - a._score)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return textResult("No matching cases found.");
        }

        const results = scored
          .map(
            (c: any) =>
              `### ${c.case_id} (score: ${c._score.toFixed(2)})\n- **Context:** ${c.situation?.context}\n- **Plan:** ${c.solution?.plan_id}\n- **Actions:** ${c.solution?.actions?.join(", ")}\n- **Success:** ${c.outcome?.success}\n- **Lessons:** ${c.outcome?.lessons || "—"}`,
          )
          .join("\n\n");

        return textResult(
          `## CBR Results for ${params.agent_id}\n\nFound ${scored.length} matching cases:\n\n${results}`,
        );
      },
    },

    {
      name: "cbr_store",
      label: "CBR Store Case",
      description:
        "Store a new case in the case base for future retrieval. Captures situation, solution, and outcome.",
      parameters: CbrStoreParams,
      async execute(_id: string, params: Static<typeof CbrStoreParams>) {
        const ws = resolveWorkspaceDir(api);
        const casesPath = join(ws, "agents", params.agent_id, "cases.json");
        const cases = (await readJson(casesPath)) || [];
        const maxCases = (api.pluginConfig as any)?.cbrMaxCases || 10000;

        const newCase = {
          case_id: params.case_id,
          situation: params.situation,
          solution: params.solution,
          outcome: params.outcome,
          stored_at: new Date().toISOString(),
        };

        // Check for duplicate
        const existing = cases.findIndex((c: any) => c.case_id === params.case_id);
        if (existing !== -1) {
          cases[existing] = newCase;
        } else {
          cases.push(newCase);
        }

        // Prune if over limit
        if (cases.length > maxCases) {
          cases.splice(0, cases.length - maxCases);
        }

        await writeJson(casesPath, cases);
        return textResult(
          `Case ${params.case_id} stored for '${params.agent_id}' (total: ${cases.length}, success: ${params.outcome.success})`,
        );
      },
    },
  ];
}
