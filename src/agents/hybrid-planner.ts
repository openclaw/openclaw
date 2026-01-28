import os from "node:os";
import path from "node:path";

import type { ClawdbrainConfig } from "../config/config.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import type { ModelRef } from "./model-selection.js";

function extractLastText(payloads: Array<{ text?: string }> | undefined): string {
  if (!payloads || payloads.length === 0) return "";
  for (let i = payloads.length - 1; i >= 0; i--) {
    const text = payloads[i]?.text ?? "";
    if (text.trim()) return text.trim();
  }
  return "";
}

export type HybridPlannerSpec = {
  version: 1;
  intent: string;
  stakes?: "low" | "medium" | "high";
  verifiability?: "low" | "medium" | "high";
  maxToolCalls?: number;
  allowWriteTools?: boolean;
  checklist: string[];
  escalateIf: string[];
};

export async function planHybridSpec(params: {
  cfg: ClawdbrainConfig;
  intent: string;
  planner: ModelRef;
  hints?: {
    stakes?: "low" | "medium" | "high";
    verifiability?: "low" | "medium" | "high";
    maxToolCalls?: number;
    allowWriteTools?: boolean;
  };
  prompt: string;
  workspaceDir: string;
  agentDir?: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ spec: HybridPlannerSpec | null; raw: string }> {
  const safeIntent = params.intent.replace(/[^a-z0-9_.-]/gi, "-");
  const sessionId = `planner-${safeIntent}-${Date.now()}`;
  const sessionFile = path.join(os.tmpdir(), `${sessionId}.jsonl`);

  const plannerPrompt = [
    "You are a planning model. Produce a compact execution spec for an executor model to follow.",
    "",
    "Requirements:",
    "- Output ONLY a single JSON object wrapped in <final>...</final> (no other text).",
    "- The spec must be self-contained and actionable.",
    "- Keep it short; prefer checklists and concrete stop conditions.",
    "",
    ...(params.hints
      ? [
          "Routing hints (treat as constraints):",
          params.hints.stakes ? `- stakes: ${params.hints.stakes}` : null,
          params.hints.verifiability ? `- verifiability: ${params.hints.verifiability}` : null,
          Number.isFinite(params.hints.maxToolCalls)
            ? `- maxToolCalls: ${params.hints.maxToolCalls}`
            : null,
          typeof params.hints.allowWriteTools === "boolean"
            ? `- allowWriteTools: ${params.hints.allowWriteTools}`
            : null,
          "",
        ].filter(Boolean)
      : []),
    "Schema (must match exactly; omit optional fields if unknown):",
    `{"version":1,"intent":"${params.intent}","stakes":"low|medium|high","verifiability":"low|medium|high","maxToolCalls":N,"allowWriteTools":true|false,"checklist":[...],"escalateIf":[...]}`,
    "",
    "User request:",
    params.prompt.trim(),
  ].join("\n");

  const result = await runEmbeddedPiAgent({
    sessionId,
    sessionFile,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.cfg,
    prompt: plannerPrompt,
    disableTools: true,
    enforceFinalTag: true,
    provider: params.planner.provider,
    model: params.planner.model,
    thinkLevel: "high",
    verboseLevel: "off",
    timeoutMs: params.timeoutMs,
    runId: sessionId,
    abortSignal: params.abortSignal,
  });

  const raw = extractLastText(result.payloads);
  if (!raw) return { spec: null, raw: "" };

  try {
    const parsed = JSON.parse(raw) as HybridPlannerSpec;
    if (!parsed || parsed.version !== 1 || typeof parsed.intent !== "string") {
      return { spec: null, raw };
    }
    if (!Array.isArray(parsed.checklist) || !Array.isArray(parsed.escalateIf)) {
      return { spec: null, raw };
    }
    return { spec: parsed, raw };
  } catch {
    return { spec: null, raw };
  }
}
