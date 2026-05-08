import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { consultRealtimeVoiceAgent } from "openclaw/plugin-sdk/realtime-voice";
import type { CoreAgentDeps } from "./core-bridge.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type BackgroundEmailDeliveryParams = {
  cfg: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
  logger: Logger;
  agentId: string;
  sessionKey: string;
  question: string;
  consultResult: string;
  backgroundEmailPrompt?: string;
  recipientEmail?: string;
  timeoutMs?: number;
};

const EMAIL_DELIVERY_SYSTEM_PROMPT_BASE = [
  "You are a background task agent.",
  "The user was on a phone call and asked a question. The answer has been found.",
  "Your job: send the answer to the user's email address.",
  "Use the himalaya or gog CLI tool via exec to send the email.",
  "Subject line should be concise and reference the original question.",
  "Body should contain the full answer in a clear, readable format.",
].join(" ");

const EMAIL_DELIVERY_LOOKUP_SUFFIX =
  " Look up the user's email in memory if not provided. If you cannot find the user's email or send the email, log a warning.";

function resolveEmailDeliverySystemPrompt(recipientEmail?: string): string {
  if (recipientEmail) {
    return `${EMAIL_DELIVERY_SYSTEM_PROMPT_BASE} Send the email to: ${recipientEmail}. Do NOT look up or ask for the email address — use exactly this one.`;
  }
  return `${EMAIL_DELIVERY_SYSTEM_PROMPT_BASE}${EMAIL_DELIVERY_LOOKUP_SUFFIX}`;
}

/**
 * Set of background delivery promises tracked for graceful shutdown and test cleanup.
 */
export const pendingBackgroundDeliveries = new Set<Promise<void>>();

/**
 * Awaits all pending background deliveries (for shutdown/test cleanup).
 */
export async function flushPendingBackgroundDeliveries(): Promise<void> {
  await Promise.allSettled([...pendingBackgroundDeliveries]);
}

/**
 * Spawns a fire-and-forget embedded agent run that sends the consult result
 * to the user's email via CLI tools.
 */
export function spawnEmailDeliveryAgent(params: BackgroundEmailDeliveryParams): void {
  const {
    cfg,
    agentRuntime,
    logger,
    agentId,
    sessionKey,
    question,
    consultResult,
    backgroundEmailPrompt,
    recipientEmail,
    timeoutMs,
  } = params;

  logger.info(
    `[voice-call] Spawning email delivery agent for session=${sessionKey}, agent=${agentId}, question="${question.slice(0, 80)}", consultResult="${consultResult.slice(0, 120)}"`,
  );

  const promptParts = [
    `Original question from the caller: "${question}"`,
    "",
    "Answer to send by email:",
    consultResult,
  ];
  if (recipientEmail) {
    promptParts.push("", `Recipient email address: ${recipientEmail}`);
  }
  const prompt = promptParts.join("\n");

  const task = (async () => {
    try {
      await consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger,
        agentId,
        sessionKey: `${sessionKey}:email-delivery`,
        messageProvider: "voice",
        lane: "voice-email-delivery",
        runIdPrefix: `voice-email-delivery:${sessionKey}`,
        args: { question: prompt },
        transcript: [],
        surface: "a background email delivery task",
        userLabel: "Caller",
        assistantLabel: "Agent",
        questionSourceLabel: "caller",
        timeoutMs: timeoutMs,
        extraSystemPrompt:
          backgroundEmailPrompt ?? resolveEmailDeliverySystemPrompt(recipientEmail),
        fallbackText: "",
      });
      logger.info(`[voice-call] Background email delivery completed for session ${sessionKey}`);
    } catch (err) {
      logger.error(
        `[voice-call] Background email delivery failed for session ${sessionKey}: ${String(err)}`,
      );
    }
  })();

  pendingBackgroundDeliveries.add(task);
  task.finally(() => {
    pendingBackgroundDeliveries.delete(task);
  });
}
