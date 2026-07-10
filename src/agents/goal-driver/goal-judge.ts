import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TextContent } from "../../llm/types.js";
/**
 * Bounded goal-completion judge for the {@link GoalContinuationDriver}.
 *
 * When `tools.experimental.goalDriver.judge.enabled` is set, the service wires
 * this judge into the driver. After a goal turn completes and all gates pass,
 * the driver asks the judge whether the objective is done before firing another
 * continuation. The judge is a single bounded utility-model call — it reuses the
 * exact seam `conversation-label-generator.ts` uses (the agent's configured
 * utility model via `prepareSimpleCompletionModelForAgent` +
 * `completeWithPreparedSimpleCompletionModel`), so no new provider/transport
 * plumbing is introduced. This mirrors hermes-agent's `judge_goal`
 * (hermes_cli/goals.py); the implementation here is original TypeScript.
 *
 * Fail-open by construction: an unavailable model, a transport error, an empty
 * response, or unparseable output all resolve to `continue` (or undefined),
 * never a wedge — the driver's ceiling/budget gates remain the backstop.
 */
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../simple-completion-runtime.js";
import { formatGoalContractBlock } from "./continuation-prompt.js";
import type { GoalDriverGoalSnapshot, GoalJudge, GoalJudgeVerdict } from "./driver.js";

/** Characters of the last assistant response fed to the judge. */
const RESPONSE_SNIPPET_CHARS = 6_000;
const JUDGE_MAX_TOKENS = 512;
const JUDGE_TIMEOUT_MS = 30_000;
/** Default backoff for a `wait` verdict that names no duration. */
const DEFAULT_WAIT_SECONDS = 60;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict completion judge for a standing goal an autonomous agent is pursuing.",
  "You are given the objective (and optionally a completion contract) plus the agent's most recent response.",
  "Decide whether the objective is verifiably complete.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '  {"verdict":"done","reason":"..."}      when the objective is verifiably complete',
  '  {"verdict":"continue","reason":"..."}  when more work is needed',
  '  {"verdict":"wait","seconds":N,"reason":"..."}  when the agent is blocked on async work (a build/CI/deploy) and re-poking now is busy-work',
  "",
  "Rules: when a contract is present, decide DONE strictly against its Verification criterion and never DONE if a Constraint was violated.",
  "When unsure, prefer continue. Keep reason under 200 characters.",
].join("\n");

export type GoalJudgeDeps = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  /** Model ref override; when unset the agent's utility model is used. */
  modelRef?: string;
  /** Returns the agent's most recent response text for the session, if any. */
  readLastResponse: (sessionKey: string) => Promise<string | undefined> | string | undefined;
  log?: {
    debug?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
  /** Completion timeout override (ms). */
  timeoutMs?: number;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`;
}

/** Builds the judge system/user prompt from the goal snapshot and last response. */
export function buildGoalJudgePrompt(
  goal: Pick<GoalDriverGoalSnapshot, "objective" | "contract">,
  lastResponse: string,
): { system: string; user: string } {
  const contractBlock = formatGoalContractBlock(goal.contract);
  const user = [
    "<objective>",
    goal.objective.trim(),
    "</objective>",
    ...(contractBlock
      ? ["", "<completion_contract>", contractBlock, "</completion_contract>"]
      : []),
    "",
    "<agent_last_response>",
    truncate(lastResponse.trim(), RESPONSE_SNIPPET_CHARS),
    "</agent_last_response>",
    "",
    "Return the JSON verdict now.",
  ].join("\n");
  return { system: JUDGE_SYSTEM_PROMPT, user };
}

function coerceVerdict(value: unknown): "done" | "continue" | "wait" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "done" || normalized === "continue" || normalized === "wait"
    ? normalized
    : undefined;
}

function coerceSeconds(record: Record<string, unknown>): number | undefined {
  const raw = record.seconds ?? record.wait_seconds ?? record.waitSeconds;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Parse the judge's reply into a verdict. Fail-open: empty or unparseable output
 * returns undefined so the driver falls through to a normal continuation.
 */
export function parseGoalJudgeVerdict(raw: string): GoalJudgeVerdict | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const verdict = coerceVerdict(record.verdict);
  if (!verdict) {
    return undefined;
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : undefined;
  if (verdict === "wait") {
    return {
      verdict: "wait",
      seconds: coerceSeconds(record) ?? DEFAULT_WAIT_SECONDS,
      ...(reason ? { reason } : {}),
    };
  }
  return { verdict, ...(reason ? { reason } : {}) };
}

/**
 * Builds the {@link GoalJudge} the driver calls. Returns `continue` when there
 * is nothing to judge (no last response), and fails open to `undefined` on any
 * model-preparation / completion / parse failure.
 */
export function createGoalJudge(deps: GoalJudgeDeps): GoalJudge {
  const timeoutMs = deps.timeoutMs ?? JUDGE_TIMEOUT_MS;
  return async (sessionKey, goal) => {
    const lastResponse = (await deps.readLastResponse(sessionKey))?.trim() ?? "";
    if (!lastResponse) {
      // Nothing substantive to evaluate this turn — let the continuation fire.
      return { verdict: "continue" };
    }

    let prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>;
    try {
      prepared = await prepareSimpleCompletionModelForAgent({
        cfg: deps.cfg,
        agentId: deps.agentId,
        ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
        ...(deps.modelRef ? { modelRef: deps.modelRef } : { useUtilityModel: true }),
        useAsyncModelResolution: true,
        allowMissingApiKeyModes: ["aws-sdk"],
      });
    } catch (err) {
      deps.log?.warn?.({ err: String(err), sessionKey }, "goal-judge: model preparation failed");
      return undefined;
    }
    if ("error" in prepared) {
      deps.log?.debug?.({ error: prepared.error, sessionKey }, "goal-judge: no model available");
      return undefined;
    }

    const { system, user } = buildGoalJudgePrompt(goal, lastResponse);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const maxTokens = Math.min(JUDGE_MAX_TOKENS, Math.floor(prepared.model.maxTokens));
      const result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        cfg: deps.cfg,
        context: {
          systemPrompt: system,
          messages: [{ role: "user", content: user, timestamp: Date.now() }],
        },
        options: { maxTokens, temperature: 0, signal: controller.signal },
      });
      if (result.stopReason === "error") {
        deps.log?.debug?.(
          { error: result.errorMessage, sessionKey },
          "goal-judge: completion errored",
        );
        return undefined;
      }
      const text = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text)
        .join("")
        .trim();
      const verdict = parseGoalJudgeVerdict(text);
      deps.log?.info?.(
        { sessionKey, verdict: verdict?.verdict ?? "unparsed" },
        "goal-judge: verdict",
      );
      return verdict;
    } catch (err) {
      deps.log?.warn?.({ err: String(err), sessionKey }, "goal-judge: completion failed");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  };
}
