// Real-path proof: a history read through the production entry point with deep nesting.
import { describe, expect, it } from "vitest";
import { consumeCodexHistory } from "./session-history-read.js";

const DEPTH = 4000;
const HEADER = { type: "session", id: "codex-session" };

function deepMessage(): Record<string, unknown> {
  let payload: unknown = { type: "input_image", image_url: "data:image/png;base64,invalid!" };
  for (let index = 0; index < DEPTH; index += 1) {
    payload = { x: payload };
  }
  return { role: "user", content: payload };
}

describe("consumeCodexHistory with deeply nested mirrored history", () => {
  it("projects the history instead of failing the read", () => {
    const messages = [deepMessage()];
    const projected = consumeCodexHistory(messages, HEADER, "codex-session", (iterable) => [
      ...iterable,
    ]);

    expect(projected).toHaveLength(1);
    let cursor: unknown = (projected[0] as { content: unknown }).content;
    for (let index = 0; index < DEPTH; index += 1) {
      cursor = (cursor as { x: unknown }).x;
    }
    expect(cursor).toEqual({
      type: "input_text",
      text: "[codex mirrored history] omitted image payload: invalid inline image data",
    });
  });
});
