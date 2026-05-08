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
  timeoutMs?: number;
};

const DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS = 120_000;

const EMAIL_DELIVERY_SYSTEM_PROMPT = [
  "You are a background task agent.",
  "The user was on a phone call and asked a question. The answer has been found.",
  "Your job: send the answer to the user's email address.",
  "Look up the user's email in memory if not provided.",
  "Use the himalaya or gog CLI tool via exec to send the email.",
  "Subject line should be concise and reference the original question.",
  "Body should contain the full answer in a clear, readable format.",
  "If you cannot find the user's email or send the email, log a warning.",
].join(" ");

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
    timeoutMs,
  } = params;

  logger.info(
    `[voice-call] Spawning email delivery agent for session=${sessionKey}, agent=${agentId}, question="${question.slice(0, 80)}"`,
  );

  const prompt = [
    `Original question from the caller: "${question}"`,
    "",
    "Answer to send by email:",
    consultResult,
  ].join("\n");

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
        timeoutMs: timeoutMs ?? DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS,
        extraSystemPrompt: backgroundEmailPrompt ?? EMAIL_DELIVERY_SYSTEM_PROMPT,
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
