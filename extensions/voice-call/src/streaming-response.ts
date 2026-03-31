/**
 * Streaming voice response generator.
 * Calls the Anthropic Messages API directly with stream:true,
 * detects sentence boundaries, and emits text chunks for TTS.
 */

import type { VoiceCallConfig } from "./config.js";

const SENTENCE_ENDINGS = /[.!?]/;
const MAX_BUFFER_CHARS = 100; // Flush at comma/space after this many chars

export type StreamingResponseParams = {
  voiceConfig: VoiceCallConfig;
  apiKey: string;
  baseUrl?: string;
  from: string;
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  userMessage: string;
  /** Called for each sentence-sized chunk as it's ready */
  onSentence: (text: string) => void;
  /** Called when the full response is done */
  onDone: (fullText: string) => void;
  /** Called on error */
  onError: (error: Error) => void;
  timeoutMs?: number;
};

/** Detect if buffer contains a sentence boundary worth flushing. */
function findFlushPoint(buffer: string): number {
  // Look for sentence-ending punctuation followed by a space or end of string
  for (let i = 0; i < buffer.length; i++) {
    if (SENTENCE_ENDINGS.test(buffer[i]!)) {
      // Check if next char is space, end of string, or quote
      const next = buffer[i + 1];
      if (!next || next === " " || next === '"' || next === "'") {
        return i + 1;
      }
    }
  }

  // If buffer is getting long, flush at next comma or space
  if (buffer.length >= MAX_BUFFER_CHARS) {
    // Try comma first
    for (let i = MAX_BUFFER_CHARS - 20; i < buffer.length; i++) {
      if (buffer[i] === ",") return i + 1;
    }
    // Then space
    for (let i = MAX_BUFFER_CHARS - 10; i < buffer.length; i++) {
      if (buffer[i] === " ") return i;
    }
  }

  return -1;
}

export async function streamVoiceResponse(params: StreamingResponseParams): Promise<void> {
  const {
    voiceConfig,
    apiKey,
    baseUrl = "https://api.anthropic.com",
    from,
    transcript,
    userMessage,
    onSentence,
    onDone,
    onError,
    timeoutMs = 15000,
  } = params;

  // Build messages array from transcript
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const entry of transcript) {
    messages.push({
      role: entry.speaker === "user" ? "user" : "assistant",
      content: entry.text,
    });
  }
  // Add current user message
  messages.push({ role: "user", content: userMessage });

  // Build system prompt
  const systemPrompt =
    voiceConfig.responseSystemPrompt ??
    `You are an AI receptionist on a phone call. Keep responses brief (1-2 sentences). Be natural and friendly. Caller: ${from}.`;

  // Resolve model
  const modelRef = voiceConfig.responseModel || "claude-haiku-4-5-20251001";
  const model = modelRef.includes("/") ? modelRef.split("/")[1]! : modelRef;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Normalize base URL — strip trailing /v1 if present
    const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");

    const response = await fetch(`${normalizedBase}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        stream: true,
        system: systemPrompt,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Anthropic API error (${response.status}): ${errorBody.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    // Parse SSE stream
    let buffer = "";
    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!; // Keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);

          // content_block_delta with text delta
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text = event.delta.text;
            buffer += text;
            fullText += text;

            // Check for sentence boundary to flush
            let flushPoint = findFlushPoint(buffer);
            while (flushPoint > 0) {
              const sentence = buffer.slice(0, flushPoint).trim();
              if (sentence) {
                onSentence(sentence);
              }
              buffer = buffer.slice(flushPoint).trimStart();
              flushPoint = findFlushPoint(buffer);
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Flush remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      onSentence(remaining);
    }

    onDone(fullText);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      onError(new Error("Voice response timed out"));
    } else {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    clearTimeout(timeout);
  }
}
