/**
 * Anti-Rationalization Plugin
 *
 * Uses an LLM (Haiku) to detect when the agent is rationalizing incomplete work.
 *
 * Patterns caught:
 * - "These issues are pre-existing / out of scope"
 * - "Too many issues to fix all of them"
 * - "I'll leave this for a follow-up"
 * - Listing problems without fixing them
 * - Skipping test/lint failures with excuses
 *
 * Inspired by Trail of Bits' Claude Code config:
 * https://github.com/trailofbits/claude-code-config
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createModel } from "@mariozechner/pi-ai";

const REVIEW_PROMPT = `Review the assistant's final response for signs of rationalizing incomplete work.

Common rationalization patterns:
- Claiming issues are "pre-existing" or "out of scope" to avoid fixing them
- Saying there are "too many issues" to address all of them  
- Deferring work to a "follow-up" that was not requested
- Listing problems without fixing them and calling that "done"
- Skipping test/lint failures with excuses
- Asking "want me to try again?" when the task is obviously incomplete

Respond with JSON only:
{
  "incomplete": true/false,
  "reason": "Brief explanation of why the work is incomplete (if true)",
  "confidence": 0-100 (how confident you are in this judgment)
}

Assistant's response:
"""
{{ASSISTANT_MESSAGE}}
"""

Your judgment (JSON only):`;

interface JudgmentResult {
  incomplete: boolean;
  reason?: string;
  confidence?: number;
}

async function reviewWithLLM(
  message: string,
  modelId: string,
  config: any,
  logger: any,
): Promise<JudgmentResult | null> {
  try {
    const prompt = REVIEW_PROMPT.replace("{{ASSISTANT_MESSAGE}}", message);

    // Create model instance from config
    const model = createModel(modelId, config);

    // Call model for judgment
    const response = await model.generate({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });

    // Extract text from response
    const text = response.content?.[0]?.text || response.text || "";
    
    // Parse JSON response
    const cleaned = text.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
    const judgment: JudgmentResult = JSON.parse(cleaned);

    logger.debug(
      `[anti-rationalization] LLM judgment: incomplete=${judgment.incomplete} confidence=${judgment.confidence}`,
    );

    return judgment;
  } catch (err) {
    logger.warn(`[anti-rationalization] LLM review failed: ${String(err)}`);
    return null;
  }
}

function extractMessageText(msg: AgentMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  } else if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

export default function antiRationalizationPlugin(api: OpenClawPluginApi) {
  const config = api.pluginConfig;
  const enabled = config?.enabled !== false;
  const modelId = (config?.model as string) || "anthropic/claude-haiku-4-5-20251001";
  const confidenceThreshold = (config?.confidenceThreshold as number) || 70;
  const fallbackToRegex = config?.fallbackToRegex !== false;

  if (!enabled) {
    api.logger.info("[anti-rationalization] Disabled via config");
    return;
  }

  api.on("agent_end", async (event, ctx) => {
    // Skip if agent run failed (error state)
    if (!event.success) {
      api.logger.debug("[anti-rationalization] Skipping - agent run failed");
      return;
    }

    // Extract last assistant message
    const lastMsg = event.messages[event.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      api.logger.debug("[anti-rationalization] No assistant message found");
      return;
    }

    const messageText = extractMessageText(lastMsg);

    if (!messageText || messageText.length < 20) {
      api.logger.debug("[anti-rationalization] Message too short to review");
      return;
    }

    // Review with LLM using OpenClaw's config
    const judgment = await reviewWithLLM(messageText, modelId, api.config, api.logger);

    if (!judgment) {
      if (fallbackToRegex) {
        api.logger.info("[anti-rationalization] LLM review failed, falling back to regex");
        // Simple regex fallback
        if (
          /\b(pre-existing|out of scope|too many issues|leave.*for.*follow-?up)\b/i.test(
            messageText,
          )
        ) {
          ctx.injectMessage?.(
            "You appear to be rationalizing incomplete work. Please finish the task properly.",
          );
        }
      }
      return;
    }

    if (judgment.incomplete) {
      const confidence = judgment.confidence || 0;

      if (confidence >= confidenceThreshold) {
        const reason =
          judgment.reason ||
          "You are rationalizing incomplete work. Go back and finish the task properly.";

        api.logger.warn(
          `[anti-rationalization] Forcing continuation (confidence: ${confidence}%)`,
        );

        ctx.injectMessage?.(reason);
      } else {
        api.logger.info(
          `[anti-rationalization] Low confidence (${confidence}%), not forcing continuation (threshold: ${confidenceThreshold}%)`,
        );
      }
    } else {
      api.logger.debug("[anti-rationalization] Work appears complete");
    }
  });

  api.logger.info(
    `[anti-rationalization] Loaded (model: ${modelId}, confidence threshold: ${confidenceThreshold}%)`,
  );
}
