import type { OpenAIQuicksilverInboundEvent } from "./realtime-quicksilver-events.js";
import type { OpenAIQuicksilverTranscriptEntry } from "./realtime-quicksilver-instructions.js";
import {
  boundOpenAIQuicksilverContextItems,
  chunkOpenAIQuicksilverAppendText,
  OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES,
} from "./realtime-quicksilver-wire.js";

type TranscriptEvent = Extract<
  OpenAIQuicksilverInboundEvent,
  { kind: "transcript-delta" | "transcript-done" }
>;
type TranscriptCallback = (role: "user" | "assistant", text: string, final: boolean) => void;
type PublicationTarget = { onTranscript?: TranscriptCallback; isCurrent?: () => boolean };

/** Context eviction and immutable transcript publication have separate lifetimes. */
export class OpenAIQuicksilverTranscript {
  private entries: OpenAIQuicksilverTranscriptEntry[] = [];
  private pendingUserInput = "";
  private partialRole: "user" | "assistant" | undefined;
  private publication: OpenAIQuicksilverTranscriptEntry[] = [];
  private publicationBytes = 0;

  append(event: TranscriptEvent): void {
    const last = this.entries.at(-1);
    if (last?.role === event.role && this.partialRole === event.role) {
      last.text = event.kind === "transcript-delta" ? last.text + event.text : event.text;
    } else {
      this.entries.push({ role: event.role, text: event.text });
    }
    this.partialRole = event.kind === "transcript-delta" ? event.role : undefined;
    this.entries = boundOpenAIQuicksilverContextItems(this.entries);
  }

  appendPublic(
    event: TranscriptEvent,
    target: PublicationTarget & { canAppend: () => boolean },
  ): void {
    for (const text of chunkOpenAIQuicksilverAppendText(
      event.text,
      OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES,
    )) {
      if (!target.canAppend()) {
        return;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (this.publicationBytes + bytes > OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES) {
        // Detach the whole old batch before callbacks can close or replace its owner.
        this.publish(this.consumePublication(), target);
        if (!target.canAppend()) {
          return;
        }
      }
      this.appendPublicContext({ ...event, text });
      const aggregate = this.publication.find((entry) => entry.role === event.role);
      if (aggregate) {
        aggregate.text += text;
      } else {
        this.publication.push({ role: event.role, text });
      }
      this.publicationBytes += bytes;
      target.onTranscript?.(event.role, text, false);
    }
  }

  private appendPublicContext(event: TranscriptEvent): void {
    if (event.role === "user") {
      this.pendingUserInput = boundOpenAIQuicksilverContextItems(
        chunkOpenAIQuicksilverAppendText(this.pendingUserInput + event.text).map((text) => ({
          role: "user",
          text,
        })),
      )
        .map((entry) => entry.text)
        .join("");
    }
    const last = this.entries.at(-1);
    let text = event.text;
    if (last?.role === event.role && this.partialRole === event.role) {
      this.entries.pop();
      text = last.text + text;
    }
    this.entries.push(
      ...chunkOpenAIQuicksilverAppendText(text).map((chunk) => ({ role: event.role, text: chunk })),
    );
    this.entries = boundOpenAIQuicksilverContextItems(this.entries);
    this.partialRole = event.role;
  }

  latestUserInput(): string {
    return this.pendingUserInput;
  }

  clearPendingUserInput(): void {
    this.pendingUserInput = "";
    this.partialRole = undefined;
  }

  consume(): {
    context: OpenAIQuicksilverTranscriptEntry[];
    publication: OpenAIQuicksilverTranscriptEntry[];
  } {
    const snapshot = { context: this.entries, publication: this.consumePublication() };
    this.clear();
    return snapshot;
  }

  private consumePublication(): OpenAIQuicksilverTranscriptEntry[] {
    const publication = this.publication;
    this.publication = [];
    this.publicationBytes = 0;
    return publication;
  }

  publish(
    publication: readonly OpenAIQuicksilverTranscriptEntry[],
    target: PublicationTarget,
  ): void {
    for (const entry of publication) {
      if (target.isCurrent?.() === false) {
        break;
      }
      target.onTranscript?.(entry.role, entry.text, true);
    }
  }

  clear(): void {
    this.entries = [];
    this.clearPendingUserInput();
    this.consumePublication();
  }
}
