import type { Detector } from "../interfaces/detector.ts";
import type { AgentRepository } from "../repository/agent-repository.ts";
import type { MessageRepository } from "../repository/message-repository.ts";
import type { OllamaRepository } from "../repository/ollama-repository.ts";
import type { EscalationAction, Logger, MeetingClassification, StoredMessage } from "../types.ts";

export type MeetingDetectorDeps = {
  messageRepo: MessageRepository;
  ollama: OllamaRepository;
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
   * Agent A prompt — rule-based classifier with clear TRUE/FALSE conditions.
   */
  const buildAgentAPrompt = (conversation: string): string =>
    `You are a classifier. Analyze this WhatsApp conversation.

Determine:
1. has_agreed_to_meet: Have the participants agreed to physically meet in person?
2. has_agreed_date: Have they agreed on a specific date/time for meeting?

has_agreed_to_meet is TRUE when:
- Both participants commit to a physical in-person activity together (dinner, hiking, cycling, shopping, road trip, reunion, etc.)
- Agreement counts even if the exact date or location is not yet decided
- Someone initially declines but later changes their mind and agrees

has_agreed_to_meet is FALSE when:
- It is a video call, phone call, gaming session, or any online-only activity
- Plans were agreed but then CANCELLED by either party
- The arrangement is sarcastic or a joke (not genuine)
- They express vague wishes ("we should do something") without concrete commitment
- They are arranging something for OTHER people, not themselves
- There is no face-to-face contact (leaving items on doorstep, posting mail, picking up items)

has_agreed_date rules:
- If has_agreed_to_meet is false, has_agreed_date MUST also be false
- True ONLY if they agreed on a specific date or time for their physical meeting
- Mentioning a date in conversation is NOT enough — both must agree to it

Include a brief reason for your decision.

Respond with JSON only.

--- Conversation ---
${conversation}`;

  /**
   * Agent B prompt — step-by-step classifier with emphasis on reading the entire conversation.
   */
  const buildAgentBPrompt = (conversation: string): string =>
    `You are a classifier. Analyze this WhatsApp conversation.

Determine:
1. has_agreed_to_meet: Have the participants agreed to physically meet in person?
2. has_agreed_date: Have they agreed on a specific date/time for meeting?

STEP 1: Check if has_agreed_to_meet is TRUE. ALL of these must be true:
- The activity is PHYSICAL and in-person (NOT video calls, phone calls, FaceTime, gaming, or online activities)
- BOTH chatters will be PRESENT at the same place — if one person says they can't come, won't be there, or is away, the answer is FALSE
- The agreement is GENUINE (not sarcastic or joking)
- The commitment is CONCRETE (not vague wishes like "we should sometime" or "one of these days")
- The plans are NOT cancelled
- The chatters are meeting EACH OTHER (not just planning something for other people where one chatter won't attend)
- There IS face-to-face contact (not just errands like picking up items, posting mail, or leaving things at a doorstep)

IMPORTANT: Read the ENTIRE conversation. If someone initially seems interested but then DECLINES ("I can't", "I'm away", "I'm busy that day"), the final answer is what matters. A decline at the end overrides earlier enthusiasm. Only count it as TRUE if the person who declined later CHANGES THEIR MIND and genuinely agrees.

STEP 2: Check has_agreed_date:
- If has_agreed_to_meet is FALSE, has_agreed_date MUST be FALSE
- Otherwise, TRUE only if both agreed on a specific date/time for their physical meeting

Include a brief reason for your decision.

Respond with JSON only.

--- Conversation ---
${conversation}`;

  // Agent definitions — each agent has a name, model, and prompt builder
  const AGENTS = [
    { name: "A", model: "qwen3.5:4b", buildPrompt: buildAgentAPrompt },
    { name: "B", model: "llama3.1:8b", buildPrompt: buildAgentBPrompt },
  ];

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

  const { messageRepo, ollama, agentRepo, logger } = deps;

  return async (ctx) => {
    const { conversationId } = ctx;

    const messages = messageRepo.getConversation(conversationId, { limit: CONTEXT_LIMIT });
    const conversation = formatConversation(messages);

    // Run agents sequentially — each gets its own prompt and model
    const classifications: Array<MeetingClassification | null> = [];
    for (const agent of AGENTS) {
      const prompt = agent.buildPrompt(conversation);
      const result = await ollama.generate<MeetingClassification>({
        prompt,
        format: CLASSIFICATION_FORMAT,
        model: agent.model,
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
