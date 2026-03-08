import type { Detector } from "../interfaces/detector.ts";
import type { AgentRepository } from "../repository/agent-repository.ts";
import type { MessageRepository } from "../repository/message-repository.ts";
import type { OllamaRepository } from "../repository/ollama-repository.ts";
import type { EscalationAction, Logger, MeetingClassification, StoredMessage } from "../types.ts";

export type MeetingDetectorAgent = {
  name: string;
  ollama: OllamaRepository;
  buildPrompt: (conversation: string) => string;
};

export type MeetingDetectorDeps = {
  messageRepo: MessageRepository;
  agents: MeetingDetectorAgent[];
  agentRepo: AgentRepository;
  logger: Logger;
};

export type MeetingDetectorResult = {
  escalation: EscalationAction;
  agentNotified: boolean;
  classifications: Array<MeetingClassification | null>;
};

/**
 * Meeting detector command.
 * Queries the message repository for the last 20 messages, classifies via
 * multiple Ollama agents sequentially, and uses consensus logic to determine
 * the escalation action.
 *
 * Consensus rules:
 * - Any null result → "none" (error = do nothing)
 * - Both T+T → "add_calendar_event"
 * - Exactly one T+T → "confirm_with_customer"
 * - All other combinations → "none"
 */
export const meetingDetector: Detector<MeetingDetectorDeps, MeetingDetectorResult> = (deps) => {
  // Structured output schema for classification
  const CLASSIFICATION_FORMAT = {
    type: "object",
    properties: {
      has_agreed_to_meet: { type: "boolean" },
      has_agreed_date: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["has_agreed_to_meet", "has_agreed_date", "reason"],
  };

  // How many messages the meeting detector pulls from the repository
  const CONTEXT_LIMIT = 20;

  /**
   * Format a timestamp (ms epoch) as HH:MM.
   */
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  /**
   * Format StoredMessage[] into a readable conversation string.
   * Outbound messages are labelled "You", inbound use sender_name or sender.
   */
  const formatConversation = (messages: StoredMessage[]): string =>
    messages
      .map((m) => {
        const time = formatTime(m.timestamp);
        const name = m.direction === "outbound" ? "You" : (m.sender_name ?? m.sender);
        return `[${time}] ${name}: ${m.content}`;
      })
      .join("\n");

  /**
   * Determine the escalation action based on consensus of classification results.
   * Any null → "none"; both T+T → "add_calendar_event";
   * exactly one T+T → "confirm_with_customer"; else → "none".
   */
  const determineEscalation = (results: Array<MeetingClassification | null>): EscalationAction => {
    // Any null means an error occurred — do nothing
    if (results.some((r) => r === null)) return "none";

    const isTT = (r: MeetingClassification) => r.has_agreed_to_meet && r.has_agreed_date;
    const ttCount = results.filter((r) => isTT(r!)).length;

    if (ttCount === results.length) return "add_calendar_event";
    if (ttCount === 1) return "confirm_with_customer";
    return "none";
  };

  /**
   * Build the prompt sent to the main agent when both models agree (add calendar event).
   */
  const buildCalendarAgentPrompt = (conversation: string): string =>
    `Two independent classifiers have both confirmed that the following WhatsApp conversation contains arrangements to meet up in person. Please process this as a calendar event.

If the calendar-guard skill is available, use it to process this event.
Otherwise, ask me if I'd like to create a calendar event. Provide a brief summary including who is meeting, when, and where (if mentioned).

--- Conversation ---
${conversation}`;

  /**
   * Build the prompt sent to the main agent when models disagree (confirm with customer).
   */
  const buildConfirmationAgentPrompt = (conversation: string, reasons: string[]): string =>
    `A classifier has flagged the following WhatsApp conversation as potentially containing arrangements to meet up in person, but there is disagreement between models. Please confirm with me whether this is actually a meeting arrangement.

Model reasons:
${reasons.map((r) => `- ${r}`).join("\n")}

Please review the conversation and ask me to confirm whether I'd like to create a calendar event.

--- Conversation ---
${conversation}`;

  const { messageRepo, agents, agentRepo, logger } = deps;

  return async (ctx) => {
    const { conversationId } = ctx;

    const messages = messageRepo.getConversation(conversationId, { limit: CONTEXT_LIMIT });
    const conversation = formatConversation(messages);

    // Run agents sequentially — each gets its own prompt and model
    const classifications: Array<MeetingClassification | null> = [];
    for (const agent of agents) {
      const prompt = agent.buildPrompt(conversation);
      const result = await agent.ollama.generate<MeetingClassification>({
        prompt,
        format: CLASSIFICATION_FORMAT,
      });
      classifications.push(result);
    }

    const escalation = determineEscalation(classifications);

    // No escalation — log and return
    if (escalation === "none") {
      logger.info(`meeting-detector: no escalation for ${conversationId}`);
      return { escalation, agentNotified: false, classifications };
    }

    // Build the appropriate agent prompt based on escalation type
    let agentPrompt: string;
    if (escalation === "add_calendar_event") {
      agentPrompt = buildCalendarAgentPrompt(conversation);
    } else {
      // confirm_with_customer — include reasons from T+T models
      const reasons = classifications
        .filter(
          (c): c is MeetingClassification =>
            c !== null && c.has_agreed_to_meet && c.has_agreed_date,
        )
        .map((c) => c.reason);
      agentPrompt = buildConfirmationAgentPrompt(conversation, reasons);
    }

    const agentResult = await agentRepo.send(agentPrompt);

    return { escalation, agentNotified: agentResult.success, classifications };
  };
};
