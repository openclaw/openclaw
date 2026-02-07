import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { z } from "zod";

export type HotStateRiskLevel = "low" | "medium" | "high";

export type ArtifactType = "repo" | "doc" | "code" | "log" | "data" | "plan" | "result";

/**
 * Reference to an artifact in the artifact store.
 * Used to avoid embedding large content directly in hot state.
 */
export const ArtifactIndexEntrySchema = z.object({
  artifact_id: z.string().min(1),
  type: z.enum(["repo", "doc", "code", "log", "data", "plan", "result"]),
  label: z.string().optional(),
  version: z.string().optional(),
  summary: z.string().optional(),
});

export type ArtifactIndexEntry = z.infer<typeof ArtifactIndexEntrySchema>;

/**
 * Hot State is the small, structured JSON blob that should be included on every turn.
 *
 * Constraints (from Mindframe perf spec):
 * - JSON only
 * - schema validated
 * - size capped (<= 1,000 tokens)
 */
export const HotStateSchema = z
  .object({
    session_id: z.string().min(1),
    session_key: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),

    objective: z.string().min(1).optional(),
    current_plan_id: z.string().min(1).nullable().optional(),
    accepted_decisions: z.array(z.string()).optional(),
    open_questions: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    last_successful_step: z.string().min(1).optional(),
    risk_level: z.enum(["low", "medium", "high"]).optional(),

    /** Artifact index: references to large content stored externally */
    artifact_index: z.array(ArtifactIndexEntrySchema).optional(),
  })
  .strict();

export type HotState = z.infer<typeof HotStateSchema>;

export function buildHotState(input: HotState): HotState {
  return HotStateSchema.parse(input);
}

export function formatHotStateJson(hotState: HotState): string {
  // JSON only, stable key ordering (insertion order). Avoid free-form prose.
  return JSON.stringify(hotState);
}

export function estimateHotStateTokens(json: string): number {
  const msg: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: json }],
  };
  return estimateTokens(msg);
}

export function enforceHotStateTokenCap(params: { hotState: HotState; maxTokens?: number }): {
  hotState: HotState;
  json: string;
  tokens: number;
  wasTruncated: boolean;
} {
  const maxTokens = Math.max(1, Math.floor(params.maxTokens ?? 1000));

  // First attempt: full hot state.
  const json = formatHotStateJson(params.hotState);
  const tokens = estimateHotStateTokens(json);
  if (tokens <= maxTokens) {
    return { hotState: params.hotState, json, tokens, wasTruncated: false };
  }

  // Fallback: minimal, always-valid hot state.
  const minimal: HotState = buildHotState({
    session_id: params.hotState.session_id,
    session_key: params.hotState.session_key,
    run_id: params.hotState.run_id,
    risk_level: params.hotState.risk_level,
  });
  const minimalJson = formatHotStateJson(minimal);
  const minimalTokens = estimateHotStateTokens(minimalJson);
  return { hotState: minimal, json: minimalJson, tokens: minimalTokens, wasTruncated: true };
}
