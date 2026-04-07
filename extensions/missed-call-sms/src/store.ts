/**
 * Missed-Call-to-SMS — conversation store.
 *
 * JSONL-backed keyed store matching the voice-call pattern
 * (~/.openclaw/voice-calls/calls.jsonl). Single append-only log for
 * durability; an in-memory index is rebuilt on startup.
 *
 * One conversation per caller phone number, keyed by `callerPhone` for
 * the lifetime of the "open" state. If a caller re-engages after their
 * conversation was closed, a new conversation is started with a fresh ID.
 *
 * Design note: JSONL (not sqlite) keeps deps zero and makes the log
 * trivial to inspect/back-up/ship to a customer. At SMB scale
 * (tens to hundreds of conversations per day) this is fine. If a
 * customer graduates to thousands of conversations/day we swap the
 * backing store without changing the public API.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ConversationStatus =
  // Voicemail captured, agent engaged, caller is responsive.
  | "open"
  // Voicemail captured, SMS sent, awaiting caller's first reply.
  | "awaiting-reply"
  // Agent hit an escalation keyword, owner was notified, agent is silent.
  | "escalated"
  // A human on the business side has taken over; agent is silent.
  | "human-takeover"
  // Conversation is done (resolved, timed out, or manually closed).
  | "closed";

export type MessageRole = "caller" | "agent" | "system" | "human-owner";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Provider message ID when sent via Telnyx. */
  providerMessageId?: string;
  /** ISO timestamp. */
  timestamp: string;
}

export interface VoicemailRecord {
  /** Telnyx recording URL (expires per Telnyx policy). */
  recordingUrl?: string;
  /** Deepgram transcription of the voicemail. */
  transcript?: string;
  /** Confidence 0..1 from Deepgram. */
  transcriptConfidence?: number;
  /** Seconds. */
  durationSeconds?: number;
  /** ISO timestamp. */
  capturedAt: string;
}

export interface Conversation {
  id: string;
  callerPhone: string;
  businessPhone: string;
  status: ConversationStatus;
  voicemail: VoicemailRecord | null;
  messages: ConversationMessage[];
  /** Number of autonomous agent turns so far (safety cap). */
  agentTurnCount: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Last provider call ID, for debugging. */
  lastCallId?: string;
}

interface StoreEvent {
  type:
    | "conversation-created"
    | "conversation-updated"
    | "message-appended"
    | "voicemail-attached"
    | "status-changed";
  conversationId: string;
  payload: unknown;
  timestamp: string;
}

export interface ListOptions {
  status?: string;
  limit?: number;
}

export class MissedCallSmsStore {
  private readonly path: string;
  private readonly index = new Map<string, Conversation>();
  /** callerPhone → active conversation ID (for quick re-engagement lookup). */
  private readonly activeByPhone = new Map<string, string>();
  private loaded = false;

  constructor(path?: string) {
    this.path = path ?? join(homedir(), ".openclaw", "missed-call-sms", "conversations.jsonl");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let event: StoreEvent;
        try {
          event = JSON.parse(line) as StoreEvent;
        } catch {
          // Corrupted line — skip. The append-only log tolerates this.
          continue;
        }
        this.applyEvent(event);
      }
    } catch (err: unknown) {
      // ENOENT is fine — first run, store file doesn't exist yet.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      await writeFile(this.path, "", "utf8");
    }
    this.loaded = true;
  }

  private applyEvent(event: StoreEvent): void {
    switch (event.type) {
      case "conversation-created": {
        const convo = event.payload as Conversation;
        this.index.set(convo.id, convo);
        if (this.isActiveStatus(convo.status)) {
          this.activeByPhone.set(convo.callerPhone, convo.id);
        }
        return;
      }
      case "conversation-updated": {
        const convo = event.payload as Conversation;
        this.index.set(convo.id, convo);
        if (this.isActiveStatus(convo.status)) {
          this.activeByPhone.set(convo.callerPhone, convo.id);
        } else if (this.activeByPhone.get(convo.callerPhone) === convo.id) {
          this.activeByPhone.delete(convo.callerPhone);
        }
        return;
      }
      case "message-appended": {
        const { conversationId, message } = event.payload as {
          conversationId: string;
          message: ConversationMessage;
        };
        const convo = this.index.get(conversationId);
        if (convo) {
          convo.messages.push(message);
          convo.updatedAt = event.timestamp;
        }
        return;
      }
      case "voicemail-attached": {
        const { conversationId, voicemail } = event.payload as {
          conversationId: string;
          voicemail: VoicemailRecord;
        };
        const convo = this.index.get(conversationId);
        if (convo) {
          convo.voicemail = voicemail;
          convo.updatedAt = event.timestamp;
        }
        return;
      }
      case "status-changed": {
        const { conversationId, status } = event.payload as {
          conversationId: string;
          status: ConversationStatus;
        };
        const convo = this.index.get(conversationId);
        if (convo) {
          convo.status = status;
          convo.updatedAt = event.timestamp;
          if (this.isActiveStatus(status)) {
            this.activeByPhone.set(convo.callerPhone, convo.id);
          } else if (this.activeByPhone.get(convo.callerPhone) === convo.id) {
            this.activeByPhone.delete(convo.callerPhone);
          }
        }
        return;
      }
    }
  }

  private isActiveStatus(status: ConversationStatus): boolean {
    return status === "open" || status === "awaiting-reply" || status === "human-takeover";
  }

  private async appendEvent(event: StoreEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    this.applyEvent(event);
  }

  /** Get (or create if none exists) the active conversation for a caller. */
  async getOrCreate(callerPhone: string, businessPhone: string): Promise<Conversation> {
    await this.init();
    const existingId = this.activeByPhone.get(callerPhone);
    if (existingId) {
      const existing = this.index.get(existingId);
      if (existing && this.isActiveStatus(existing.status)) return existing;
    }
    const now = new Date().toISOString();
    const convo: Conversation = {
      id: randomUUID(),
      callerPhone,
      businessPhone,
      status: "open",
      voicemail: null,
      messages: [],
      agentTurnCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.appendEvent({
      type: "conversation-created",
      conversationId: convo.id,
      payload: convo,
      timestamp: now,
    });
    return convo;
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    await this.init();
    return this.index.get(id);
  }

  async getActiveByPhone(callerPhone: string): Promise<Conversation | undefined> {
    await this.init();
    const id = this.activeByPhone.get(callerPhone);
    return id ? this.index.get(id) : undefined;
  }

  async listConversations(opts: ListOptions = {}): Promise<Conversation[]> {
    await this.init();
    const { status = "open", limit = 50 } = opts;
    const all = Array.from(this.index.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const filtered = status === "all" ? all : all.filter((c) => c.status === status);
    return filtered.slice(0, limit);
  }

  async appendMessage(
    conversationId: string,
    message: Omit<ConversationMessage, "id" | "timestamp"> & {
      id?: string;
      timestamp?: string;
    },
  ): Promise<ConversationMessage> {
    await this.init();
    const now = message.timestamp ?? new Date().toISOString();
    const full: ConversationMessage = {
      id: message.id ?? randomUUID(),
      role: message.role,
      content: message.content,
      providerMessageId: message.providerMessageId,
      timestamp: now,
    };
    await this.appendEvent({
      type: "message-appended",
      conversationId,
      payload: { conversationId, message: full },
      timestamp: now,
    });
    return full;
  }

  async attachVoicemail(conversationId: string, voicemail: VoicemailRecord): Promise<void> {
    await this.init();
    await this.appendEvent({
      type: "voicemail-attached",
      conversationId,
      payload: { conversationId, voicemail },
      timestamp: new Date().toISOString(),
    });
  }

  async setStatus(conversationId: string, status: ConversationStatus): Promise<void> {
    await this.init();
    await this.appendEvent({
      type: "status-changed",
      conversationId,
      payload: { conversationId, status },
      timestamp: new Date().toISOString(),
    });
  }

  async incrementAgentTurn(conversationId: string): Promise<number> {
    await this.init();
    const convo = this.index.get(conversationId);
    if (!convo) return 0;
    convo.agentTurnCount += 1;
    const now = new Date().toISOString();
    convo.updatedAt = now;
    // Persist as a conversation-updated snapshot so the counter survives
    // restart. This writes the whole convo object — acceptable at SMB scale.
    await this.appendEvent({
      type: "conversation-updated",
      conversationId,
      payload: convo,
      timestamp: now,
    });
    return convo.agentTurnCount;
  }
}
