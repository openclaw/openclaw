import { decryptChunk } from "./crypto.js";

/**
 * Parse an SSE stream from Venice's chat completions endpoint and yield
 * decrypted text chunks. Each SSE event contains a JSON object with
 * `choices[0].delta.content` holding an encrypted hex string (or plaintext
 * for whitespace tokens).
 *
 * Usage:
 *   const response = await fetch(url, { ... });
 *   for await (const text of decryptSSEStream(response.body, session.privateKey)) {
 *     process.stdout.write(text);
 *   }
 */
export async function* decryptSSEStream(
  body: ReadableStream<Uint8Array>,
  privateKey: Uint8Array,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        let event: { choices?: Array<{ delta?: { content?: string } }> };
        try {
          event = JSON.parse(data);
        } catch {
          continue; // skip malformed events
        }

        const content = event.choices?.[0]?.delta?.content;
        if (content === undefined || content === null) continue;

        try {
          yield await decryptChunk(privateKey, content);
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "OperationError") {
            throw new Error(
              "E2EE decryption failed — session may be stale. Clear the session and retry.",
            );
          }
          throw e;
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim();
        if (data !== "[DONE]") {
          let event: { choices?: Array<{ delta?: { content?: string } }> };
          try {
            event = JSON.parse(data);
          } catch {
            // ignore trailing partial JSON
            event = {};
          }
          const content = event.choices?.[0]?.delta?.content;
          if (content !== undefined && content !== null) {
            try {
              yield await decryptChunk(privateKey, content);
            } catch (e: unknown) {
              if (e instanceof DOMException && e.name === "OperationError") {
                throw new Error(
                  "E2EE decryption failed — session may be stale. Clear the session and retry.",
                );
              }
              throw e;
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
