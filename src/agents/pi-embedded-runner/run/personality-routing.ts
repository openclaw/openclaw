import { complete } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSimpleCompletionModel } from "../../simple-completion-runtime.js";
import { prepareModelForSimpleCompletion } from "../../simple-completion-transport.js";
import { isLikelyExecutionAckPrompt } from "./incomplete-turn.js";

/**
 * Turn intent for hybrid personality routing. The harness uses this to
 * decide whether to dispatch a turn to the execution model (GPT-5.4) or
 * the personality model (GPT-5.2) when `personalityMode: "hybrid"` is
 * active. The switching is invisible to the user — they see a synthetic
 * `gpt-5.4-psn` model name throughout.
 */
export type PersonalityTurnIntent = "execution" | "personality";

/**
 * Signals that the user's message involves code, files, tools, or
 * technical commands. When matched, the turn routes to the execution
 * model regardless of length.
 */
const EXECUTION_SIGNAL_RE =
  // eslint-disable-next-line no-useless-escape
  /```|`[^`]+`|\bfile\b|\bcode\b|\bfunction\b|\bclass\b|\bimport\b|\bfix\b|\bbuild\b|\btest\b|\brun\b|\bdeploy\b|\brefactor\b|\binstall\b|\bcreate\b|\bdelete\b|\bupdate\b|\bmodify\b|\brevert\b|\.(?:ts|js|py|rs|go|md|json|yaml|yml)\b/i;

/**
 * Classify a user turn as "execution" (needs tool work) or "personality"
 * (conversational, emotional, proactive). The classifier errs on the side
 * of execution so strict-agentic is never accidentally bypassed.
 *
 * Decision order:
 * 1. Heartbeats (cron triggers) → always personality
 * 2. Tools disabled → personality (no tool work possible)
 * 3. Short approval messages ("ok do it") → execution
 * 4. Short messages without code/file signals → personality
 * 5. Messages with code/file/technical signals → execution
 * 6. Default → execution
 */
export function classifyTurnIntent(params: {
  prompt: string;
  trigger?: string;
  disableTools?: boolean;
}): PersonalityTurnIntent {
  // Heartbeats and proactive triggers are always personality — they exist
  // for warmth and initiative, not tool execution.
  if (params.trigger === "cron" || params.trigger === "heartbeat") {
    return "personality";
  }

  // Tools disabled = conversational context, no execution possible
  if (params.disableTools) {
    return "personality";
  }

  // Short approval messages = execution (user said "ok do it", "go ahead")
  if (isLikelyExecutionAckPrompt(params.prompt)) {
    return "execution";
  }

  const trimmed = params.prompt.trim();

  // Short messages without tool/file/code signals = personality
  if (trimmed.length <= 60 && !EXECUTION_SIGNAL_RE.test(trimmed)) {
    return "personality";
  }

  // Messages with code, file refs, technical commands = execution
  if (EXECUTION_SIGNAL_RE.test(trimmed)) {
    return "execution";
  }

  // Default: execution (err on the side of getting work done)
  return "execution";
}

/**
 * Build the synthetic model display name for hybrid personality mode.
 * The user sees `gpt-5.4-psn` instead of the raw model ID, so the
 * execution↔personality switching is invisible.
 */
export function buildPersonalityHybridModelName(executionModelId: string): string {
  return `${executionModelId}-psn`;
}

/**
 * The instruction appended to execution payloads when they're sent to
 * the personality model for emotional closeout. The personality model
 * rewrites the visible text while keeping all factual content intact.
 */
/**
 * The closeout instruction for the pre-send personality sanitizer. The
 * personality model already has SOUL.md in its system prompt (loaded from
 * workspace bootstrap files during attempt setup), so it naturally adopts
 * the configured personality. This instruction just tells it to rewrite
 * the execution output rather than generating new content.
 */
export const PERSONALITY_CLOSEOUT_INSTRUCTION =
  "Rewrite the following in your natural voice and personality. " +
  "Your SOUL.md defines your personality — use it. " +
  "Keep all factual content, tool results, code blocks, and file references exactly as-is. " +
  "Add warmth and natural language framing around the technical parts. " +
  "Keep it concise — do not expand or add new information.";

/**
 * Run the pre-send personality sanitizer (Option B). Takes the execution
 * model's visible text, passes it through the personality model with the
 * closeout instruction, and returns the rewritten text. If the personality
 * model call fails for any reason, returns null so the original text is
 * used unchanged — the closeout is best-effort and should never block
 * delivery.
 *
 * The personality model's system prompt includes SOUL.md from workspace
 * bootstrap files (loaded automatically during model preparation), so it
 * naturally adopts the agent's configured personality.
 */
export async function runPersonalityCloseout(params: {
  cfg: OpenClawConfig | undefined;
  personalityProvider: string;
  personalityModelId: string;
  agentDir?: string;
  executionText: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  try {
    const prepared = await prepareSimpleCompletionModel({
      cfg: params.cfg,
      provider: params.personalityProvider,
      modelId: params.personalityModelId,
      agentDir: params.agentDir,
    });
    if ("error" in prepared) {
      return null;
    }
    const model = prepareModelForSimpleCompletion({
      model: prepared.model,
      cfg: params.cfg,
    });
    const result = await complete(
      model,
      {
        systemPrompt: PERSONALITY_CLOSEOUT_INSTRUCTION,
        messages: [{ role: "user", content: params.executionText, timestamp: Date.now() }],
      },
      {
        maxTokens: 2048,
        signal: params.signal,
      },
    );
    // AssistantMessage has .content (array of content blocks)
    const text = result?.content
      ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (text && text.length > 0) {
      return text;
    }
    return null;
  } catch {
    // Best-effort — if the personality model fails, deliver the
    // original execution output unchanged.
    return null;
  }
}
