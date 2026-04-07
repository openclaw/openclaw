/**
 * Missed-Call-to-SMS — Claude agent engine.
 *
 * Drives an SMS conversation with a caller after their voicemail is
 * transcribed. Direct fetch against the Anthropic Messages API — no
 * SDK dep, matching the lean-deps philosophy of this extension.
 *
 * Single-turn loop per inbound SMS:
 *   1. Caller sends SMS (or voicemail just landed)
 *   2. Build system prompt from business config (name, hours, FAQ, booking URL)
 *   3. Build conversation history from store messages
 *   4. Call Claude with the conversation
 *   5. Parse the response for [ESCALATE] / [CLOSE] / [SEND] markers
 *   6. Send the SMS, append to store, update conversation status
 *
 * The agent doesn't use tool calling — keeping it text-only is simpler,
 * cheaper, and more predictable for SMS where we have a tiny action surface.
 */

import type { MissedCallSmsConfig } from "./config.js";
import type { RuntimeLogger } from "./runtime.js";
import type { Conversation, ConversationMessage, MissedCallSmsStore } from "./store.js";
import type { TelnyxMessagingClient } from "./telnyx-sms.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AgentEngineOptions {
  config: MissedCallSmsConfig;
  store: MissedCallSmsStore;
  telnyxSms: TelnyxMessagingClient;
  logger: RuntimeLogger;
}

export interface AgentTurnResult {
  success: boolean;
  /** Final SMS body sent to the caller (may be empty if escalated/closed). */
  reply?: string;
  /** Set if the agent decided to escalate or close. */
  newStatus?: Conversation["status"];
  error?: string;
}

export class AgentEngine {
  private readonly config: MissedCallSmsConfig;
  private readonly store: MissedCallSmsStore;
  private readonly telnyxSms: TelnyxMessagingClient;
  private readonly logger: RuntimeLogger;

  constructor(opts: AgentEngineOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.telnyxSms = opts.telnyxSms;
    this.logger = opts.logger;
  }

  /**
   * Called when a new voicemail has been captured + transcribed.
   * Sends the first SMS proactively to the caller (the "we got your
   * message, here's how I can help" turn).
   */
  async handleVoicemail(conversationId: string): Promise<AgentTurnResult> {
    const convo = await this.store.getConversation(conversationId);
    if (!convo) return { success: false, error: "conversation not found" };
    if (!convo.voicemail?.transcript) {
      this.logger.warn(
        `[missed-call-sms] handleVoicemail called with no transcript on ${conversationId}`,
      );
    }
    return this.runTurn(convo, /* isFirstTurn */ true);
  }

  /**
   * Called when an inbound SMS arrives from the caller. Appends the
   * message and runs the agent.
   */
  async handleInboundSms(
    callerPhone: string,
    text: string,
    providerMessageId?: string,
  ): Promise<AgentTurnResult> {
    let convo = await this.store.getActiveByPhone(callerPhone);
    if (!convo) {
      // No active conversation — caller is replying out of band. Open
      // a new conversation so we don't drop the message.
      convo = await this.store.getOrCreate(callerPhone, this.config.telnyx.fromNumber!);
    }
    await this.store.appendMessage(convo.id, {
      role: "caller",
      content: text,
      providerMessageId,
    });

    // Re-fetch with the new message attached.
    const fresh = await this.store.getConversation(convo.id);
    if (!fresh) return { success: false, error: "conversation vanished" };

    // Escalation keyword check — fast path before paying for an LLM call.
    const lowered = text.toLowerCase();
    const hit = this.config.sms.escalationKeywords.find((kw) => lowered.includes(kw.toLowerCase()));
    if (hit) {
      this.logger.info(`[missed-call-sms] escalating ${convo.id} on keyword "${hit}"`);
      await this.escalate(fresh, `Caller used escalation keyword: "${hit}"`);
      return { success: true, newStatus: "escalated" };
    }

    // If a human has taken over, the autonomous agent stays silent.
    if (fresh.status === "human-takeover") {
      this.logger.info(`[missed-call-sms] ${convo.id} is in human-takeover, skipping agent turn`);
      return { success: true };
    }

    // Safety cap.
    if (fresh.agentTurnCount >= this.config.sms.maxAgentTurns) {
      this.logger.warn(
        `[missed-call-sms] ${convo.id} hit max agent turns (${this.config.sms.maxAgentTurns}), escalating`,
      );
      await this.escalate(fresh, "Conversation exceeded max agent turns");
      return { success: true, newStatus: "escalated" };
    }

    return this.runTurn(fresh, /* isFirstTurn */ false);
  }

  // -------------------- internal --------------------

  private async runTurn(convo: Conversation, isFirstTurn: boolean): Promise<AgentTurnResult> {
    try {
      const systemPrompt = this.buildSystemPrompt(isFirstTurn);
      const messages = this.buildMessages(convo, isFirstTurn);
      const llmReply = await this.callClaude(systemPrompt, messages);
      const parsed = this.parseAgentReply(llmReply);

      if (parsed.escalate) {
        await this.escalate(convo, parsed.reason ?? "Agent escalated");
        return { success: true, newStatus: "escalated" };
      }

      if (!parsed.send) {
        // Agent declined to send anything (e.g. closed). Mark closed.
        await this.store.setStatus(convo.id, "closed");
        return { success: true, newStatus: "closed" };
      }

      // Send the SMS via Telnyx.
      const result = await this.telnyxSms.send({
        to: convo.callerPhone,
        text: parsed.send,
      });
      await this.store.appendMessage(convo.id, {
        role: "agent",
        content: parsed.send,
        providerMessageId: result.messageId,
      });
      await this.store.incrementAgentTurn(convo.id);

      // After the first agent reply, the conversation is awaiting the
      // caller's response. After subsequent replies, the same is true.
      await this.store.setStatus(convo.id, "awaiting-reply");

      return { success: true, reply: parsed.send };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[missed-call-sms] agent turn failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  private buildSystemPrompt(isFirstTurn: boolean): string {
    const biz = this.config.business;
    const faqBlock = biz.faq.length
      ? `\n\nFAQ:\n${biz.faq.map((f) => `- Q: ${f.q}\n  A: ${f.a}`).join("\n")}`
      : "";
    const bookingBlock = biz.bookingUrl
      ? `\n\nBooking/Order URL: ${biz.bookingUrl} — share this when the caller wants to book, order, or schedule.`
      : "";

    const firstTurnGuidance = isFirstTurn
      ? `\n\nThis is the FIRST text the caller will receive after their voicemail. Open with a warm acknowledgment of their voicemail (reference what they said), then offer concrete next steps. Keep it under 320 characters (2 SMS segments).`
      : `\n\nThis is a follow-up message in an ongoing SMS conversation. Be concise (under 320 characters / 2 SMS segments).`;

    return `You are the AI receptionist for ${biz.name}. You handle missed-call SMS conversations on behalf of the business.

Business hours: ${biz.hoursText}.

Your job:
- Acknowledge the caller warmly
- Answer their question if you can (use FAQ below)
- Move them toward booking, ordering, or scheduling when relevant
- Hand off to a human if the question is complex, sensitive, or you're unsure
- Always sound human, friendly, and brief — this is SMS, not email${faqBlock}${bookingBlock}${firstTurnGuidance}

You MUST format your reply as ONE of these three options:
[SEND] <the SMS body to send the caller>
[ESCALATE] <one-line reason — caller will be told a human will follow up>
[CLOSE] <one-line reason — conversation appears resolved>

Do not output anything outside the marker. Do not include quotes around the body.`;
  }

  private buildMessages(
    convo: Conversation,
    isFirstTurn: boolean,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const out: Array<{ role: "user" | "assistant"; content: string }> = [];

    if (isFirstTurn && convo.voicemail?.transcript) {
      out.push({
        role: "user",
        content: `[VOICEMAIL TRANSCRIPT from ${convo.callerPhone}, confidence ${(
          convo.voicemail.transcriptConfidence ?? 0
        ).toFixed(2)}]:\n\n"${convo.voicemail.transcript}"`,
      });
      return out;
    }

    // Replay history. The voicemail (if present) becomes the first user
    // message; subsequent caller/agent SMS turns alternate.
    if (convo.voicemail?.transcript) {
      out.push({
        role: "user",
        content: `[VOICEMAIL]: "${convo.voicemail.transcript}"`,
      });
    }
    for (const msg of convo.messages) {
      if (msg.role === "caller") {
        out.push({ role: "user", content: msg.content });
      } else if (msg.role === "agent") {
        // Wrap prior agent SMS as assistant turns. We re-add the [SEND]
        // marker so the model stays in format.
        out.push({ role: "assistant", content: `[SEND] ${msg.content}` });
      }
      // human-owner messages are skipped from the LLM context — when a
      // human takes over, the agent should be silent anyway.
    }
    return out;
  }

  private async callClaude(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string> {
    const resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.anthropic.apiKey!,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.config.anthropic.model,
        max_tokens: 400,
        system,
        messages,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`anthropic call failed: ${resp.status} ${resp.statusText} ${text}`);
    }
    const json = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = json.content?.find((c) => c.type === "text")?.text ?? "";
    return text.trim();
  }

  private parseAgentReply(raw: string): {
    send?: string;
    escalate?: boolean;
    close?: boolean;
    reason?: string;
  } {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[SEND]")) {
      return { send: trimmed.slice("[SEND]".length).trim() };
    }
    if (trimmed.startsWith("[ESCALATE]")) {
      return {
        escalate: true,
        reason: trimmed.slice("[ESCALATE]".length).trim(),
      };
    }
    if (trimmed.startsWith("[CLOSE]")) {
      return {
        close: true,
        reason: trimmed.slice("[CLOSE]".length).trim(),
      };
    }
    // Model went off-format — treat the raw text as a SEND. Defensive,
    // but better than dropping the reply silently.
    this.logger.warn(
      `[missed-call-sms] agent reply lacked marker, treating as SEND: ${trimmed.slice(0, 80)}`,
    );
    return { send: trimmed };
  }

  private async escalate(convo: Conversation, reason: string): Promise<void> {
    await this.store.setStatus(convo.id, "escalated");
    await this.store.appendMessage(convo.id, {
      role: "system",
      content: `ESCALATED: ${reason}`,
    });

    // Notify the caller so they know a human is coming.
    try {
      const handoff = `Thanks — I'm handing this over to someone on our team. They'll text you back as soon as they can.`;
      await this.telnyxSms.send({ to: convo.callerPhone, text: handoff });
      await this.store.appendMessage(convo.id, {
        role: "agent",
        content: handoff,
      });
    } catch (err) {
      this.logger.error(
        `[missed-call-sms] failed to notify caller of escalation: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Notify the owner via SMS to their escalation phone.
    const ownerPhone = this.config.business.escalationPhone;
    if (ownerPhone) {
      try {
        const summary = this.summarizeForOwner(convo, reason);
        await this.telnyxSms.send({ to: ownerPhone, text: summary });
      } catch (err) {
        this.logger.error(
          `[missed-call-sms] failed to notify owner ${ownerPhone}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private summarizeForOwner(convo: Conversation, reason: string): string {
    const vm = convo.voicemail?.transcript
      ? `VM: "${convo.voicemail.transcript.slice(0, 200)}"`
      : "(no voicemail)";
    const lastCaller = [...convo.messages].reverse().find((m) => m.role === "caller");
    const last = lastCaller ? `Last text: "${lastCaller.content.slice(0, 200)}"` : "";
    return `[${this.config.business.name}] Caller ${convo.callerPhone} needs human help. ${reason}. ${vm} ${last}`.trim();
  }
}
