import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  defaultExecAutoReviewer,
  type ExecAutoReviewDecision,
  type ExecAutoReviewInput,
  type ExecAutoReviewer,
  type ExecAutoReviewRisk,
} from "../infra/exec-auto-review.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";
import { coerceToolModelConfig } from "./tools/model-config.helpers.js";

const DEFAULT_EXEC_REVIEWER_TIMEOUT_MS = 30_000;
const EXEC_REVIEWER_MAX_TOKENS = 360;
const EXEC_REVIEWER_TIMEOUT = Symbol("exec-reviewer-timeout");

export type ExecReviewerConfig = {
  model?: AgentModelConfig;
  timeoutMs?: number;
};

type ExecReviewerDeps = {
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

const EXEC_REVIEWER_SYSTEM_PROMPT = [
  "You are OpenClaw's exec safety reviewer.",
  "Review exactly one pending shell command before it runs.",
  "Return exactly one JSON object and no other text.",
  "",
  "Decision rules:",
  '- Use "allow-once" only when the command is clearly low-risk for this single execution.',
  '- Use "deny" when the command is destructive, credential-seeking, creates or modifies SSH key material, privilege-escalating, exfiltrating, or tries to bypass policy.',
  '- Use "ask-human" when intent, path safety, command parsing, or side effects are unclear.',
  "- Never return allow-always. Durable approvals are human-only.",
  "- Treat inline eval, shell wrappers, compound shell syntax, network access, package publish, chmod/chown, rm/mv, sudo, ssh/scp/rsync, and secret paths as high scrutiny.",
  "",
  'Output schema: {"decision":"allow-once|deny|ask-human","risk":"low|medium|high|unknown","rationale":"one short sentence"}',
].join("\n");

function stringifyInput(input: ExecAutoReviewInput): string {
  return JSON.stringify(
    {
      command: input.command,
      argv: input.argv,
      cwd: input.cwd,
      envKeys: input.envKeys,
      host: input.host,
      reason: input.reason,
      analysis: input.analysis,
      agent: input.agent,
    },
    null,
    2,
  );
}

function normalizeRisk(value: unknown): ExecAutoReviewRisk {
  return value === "low" || value === "medium" || value === "high" || value === "unknown"
    ? value
    : "unknown";
}

function normalizeRationale(value: unknown, fallback: string): string {
  const text = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return (text ?? fallback).slice(0, 500);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonObject(text: string): string | null {
  const stripped = stripJsonFence(text);
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    return stripped;
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return stripped.slice(start, end + 1);
  }
  return null;
}

export function parseExecAutoReviewResponse(text: string): ExecAutoReviewDecision {
  const objectText = extractJsonObject(text);
  if (!objectText) {
    return {
      decision: "ask-human",
      risk: "unknown",
      rationale: "exec reviewer returned no parseable JSON",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return {
      decision: "ask-human",
      risk: "unknown",
      rationale: "exec reviewer returned malformed JSON",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      decision: "ask-human",
      risk: "unknown",
      rationale: "exec reviewer returned an invalid JSON payload",
    };
  }
  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  const risk = normalizeRisk(record.risk);
  const rationale = normalizeRationale(record.rationale, "exec reviewer did not explain decision");
  if (decision === "allow-once") {
    if (risk !== "low") {
      return {
        decision: "ask-human",
        risk,
        rationale: "exec reviewer returned a non-low allow decision",
      };
    }
    return {
      decision,
      risk,
      rationale,
    };
  }
  if (decision === "deny") {
    return {
      decision,
      risk: risk === "low" || risk === "unknown" ? "medium" : risk,
      rationale,
    };
  }
  if (decision === "ask-human") {
    return {
      decision,
      risk,
      rationale,
    };
  }
  return {
    decision: "ask-human",
    risk,
    rationale: "exec reviewer returned an unsupported decision",
  };
}

function extractTextContent(
  result: Awaited<ReturnType<typeof completeWithPreparedSimpleCompletionModel>>,
) {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function resolveReviewerModelRef(config?: ExecReviewerConfig): string | undefined {
  return coerceToolModelConfig(config?.model).primary;
}

function resolveReviewerTimeoutMs(config?: ExecReviewerConfig): number {
  return typeof config?.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
    ? Math.max(1_000, Math.floor(config.timeoutMs))
    : DEFAULT_EXEC_REVIEWER_TIMEOUT_MS;
}

function buildReviewerTimeoutDecision(timeoutMs: number): ExecAutoReviewDecision {
  return {
    decision: "ask-human",
    risk: "unknown",
    rationale: `exec reviewer timed out after ${timeoutMs}ms`,
  };
}

async function raceWithReviewerTimeout<T>(
  promise: Promise<T>,
  params: {
    timeoutMs: number;
    onTimeout?: () => void;
  },
): Promise<T | typeof EXEC_REVIEWER_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof EXEC_REVIEWER_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      params.onTimeout?.();
      resolve(EXEC_REVIEWER_TIMEOUT);
    }, params.timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createModelExecAutoReviewer(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  reviewer?: ExecReviewerConfig;
  deps?: ExecReviewerDeps;
}): ExecAutoReviewer {
  const cfg = params.cfg;
  const agentId = params.agentId ?? "main";
  if (!cfg) {
    return defaultExecAutoReviewer;
  }
  const prepareModel =
    params.deps?.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent;
  const complete =
    params.deps?.completeWithPreparedSimpleCompletionModel ??
    completeWithPreparedSimpleCompletionModel;
  const modelRef = resolveReviewerModelRef(params.reviewer);
  const timeoutMs = resolveReviewerTimeoutMs(params.reviewer);
  return async (input) => {
    let completionController: AbortController | undefined;
    try {
      const prepared = await raceWithReviewerTimeout(
        prepareModel({
          cfg,
          agentId,
          modelRef,
          allowMissingApiKeyModes: ["aws-sdk"],
        }),
        { timeoutMs },
      );
      if (prepared === EXEC_REVIEWER_TIMEOUT) {
        return buildReviewerTimeoutDecision(timeoutMs);
      }
      if ("error" in prepared) {
        return {
          decision: "ask-human",
          risk: "unknown",
          rationale: `exec reviewer model unavailable: ${prepared.error}`,
        };
      }

      completionController = new AbortController();
      const result = await raceWithReviewerTimeout(
        complete({
          model: prepared.model,
          auth: prepared.auth,
          cfg,
          context: {
            systemPrompt: EXEC_REVIEWER_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `Review this pending exec request:\n\n${stringifyInput(input)}`,
                timestamp: Date.now(),
              },
            ],
          },
          options: {
            maxTokens: EXEC_REVIEWER_MAX_TOKENS,
            temperature: 0,
            signal: completionController.signal,
          },
        }),
        {
          timeoutMs,
          onTimeout: () => completionController?.abort(),
        },
      );
      if (result === EXEC_REVIEWER_TIMEOUT) {
        return buildReviewerTimeoutDecision(timeoutMs);
      }
      return parseExecAutoReviewResponse(extractTextContent(result));
    } catch (err) {
      if (completionController?.signal.aborted) {
        return buildReviewerTimeoutDecision(timeoutMs);
      }
      return {
        decision: "ask-human",
        risk: "unknown",
        rationale: `exec reviewer failed: ${formatErrorMessage(err)}`,
      };
    }
  };
}
