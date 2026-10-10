import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliOutput } from "./cli-output-contracts.js";
import { isClaudeSubagentRecord } from "./cli-output-records.js";

type TextSpan = {
  start?: number;
  messageId?: string;
  text: string;
  sessionId?: string;
};

/** Provider identities are admitted only after the parser selects their complete text. */
export class CliAssistantTextReceipt {
  private readonly spans: TextSpan[] = [];
  private readonly messages = new Map<
    string,
    { messageId: string; text: string; sessionId?: string; spans: TextSpan[] }
  >();
  private lastExternalId: string | undefined;
  private lastObservedSpanEnd = 0;
  private bufferedSpans: TextSpan[] = [];
  private messageSpanStart = 0;

  private append(span: TextSpan): TextSpan {
    this.spans.push(span);
    return span;
  }

  appendSelected(
    start: number,
    messageId: string | undefined,
    text: string,
    sessionId?: string,
  ): void {
    this.append({ start, messageId, text, sessionId });
  }

  select(spans: TextSpan[], start: number): void {
    let cursor = start;
    for (const span of spans) {
      span.start = cursor;
      cursor += span.text.length;
    }
  }

  buffer(messageId: string | undefined, text: string, sessionId?: string): void {
    this.bufferedSpans.push(this.append({ messageId, text, sessionId }));
  }

  startMessage(): void {
    this.messageSpanStart = this.spans.length;
  }

  identifyMessage(messageId: string, sessionId?: string): void {
    for (const span of this.spans.slice(this.messageSpanStart)) {
      if (span.messageId === undefined && span.sessionId === sessionId) {
        span.messageId = messageId;
      }
    }
  }

  selectBuffered(start: number): void {
    this.select(this.bufferedSpans, start);
    this.bufferedSpans = [];
  }

  discardBuffered(): void {
    this.bufferedSpans = [];
  }

  observe(
    parsed: Record<string, unknown>,
    messageId: string | undefined,
    sessionId?: string,
  ): void {
    if (
      parsed.type !== "assistant" ||
      !isRecord(parsed.message) ||
      isClaudeSubagentRecord(parsed) ||
      !messageId
    ) {
      return;
    }
    const message = parsed.message;
    const cumulative = message.stop_reason === null;
    const id = typeof parsed.uuid === "string" ? parsed.uuid.trim() : "";
    const text = Array.isArray(message.content)
      ? message.content
          .map((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("")
      : typeof message.content === "string"
        ? message.content
        : "";
    let spans = this.spans
      .slice(this.lastObservedSpanEnd)
      .filter((span) => span.messageId === messageId && span.sessionId === sessionId);
    if (cumulative && spans.length && spans.map((span) => span.text).join("") !== text) {
      const prefix = this.spans.filter(
        (span) => span.messageId === messageId && span.sessionId === sessionId,
      );
      // Null stop_reason also occurs on completed per-block records. Only an
      // exact emitted prefix with new source spans proves a cumulative body.
      if (prefix.map((span) => span.text).join("") === text) {
        spans = prefix;
      }
    }
    this.lastObservedSpanEnd = this.spans.length;
    if (id && text) {
      const previous = this.messages.get(id);
      if (
        !spans.length &&
        previous?.messageId === messageId &&
        previous.sessionId === sessionId &&
        previous.text === text
      ) {
        spans = previous.spans;
      }
      this.messages.set(id, { messageId, text, sessionId, spans });
      this.lastExternalId = id;
    }
  }

  read(params: {
    start: number;
    sessionId?: string;
    resultText?: string;
    previous?: CliOutput["transcriptTextReceipt"];
  }): CliOutput["transcriptTextReceipt"] {
    const { start, sessionId, resultText, previous } = params;
    if (!sessionId) {
      return undefined;
    }
    const messages = new Map(
      previous?.cliSessionId === sessionId
        ? previous.messages.map((message) => [message.externalId, message])
        : [],
    );
    for (const [externalId, native] of this.messages) {
      if (native.sessionId !== sessionId) {
        continue;
      }
      const selected =
        resultText === undefined
          ? native.spans
              .filter(
                (span) =>
                  span.messageId === native.messageId &&
                  span.sessionId === sessionId &&
                  span.start !== undefined &&
                  span.start >= start,
              )
              .map((span) => span.text)
              .join("")
          : externalId === this.lastExternalId
            ? resultText
            : "";
      // Identity proves the source; exact producer coverage proves that its
      // whole visible body belongs to this accepted aggregate.
      if (native.text.trim() && selected.trim() === native.text.trim()) {
        messages.set(externalId, { externalId, textSha256: sha256Hex(native.text) });
      }
    }
    return messages.size
      ? { provider: "claude-cli", cliSessionId: sessionId, messages: [...messages.values()] }
      : undefined;
  }
}
