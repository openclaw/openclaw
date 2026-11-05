import { TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { describe, expect, it } from "vitest";
import { toolOutputRawEchoSignature } from "./event-projector-tool-output.js";

describe("tool output echo signature", () => {
  it("keeps an emoji whole when tool output hits the transcript cap", () => {
    const text = `${"c".repeat(TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - 1)}😀ZZEND`;
    const signature = toolOutputRawEchoSignature(text);
    expect(signature?.rawPrefix).toBe("c".repeat(TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - 1));
    expect(signature?.rawLength).toBe(text.length);
    expect(signature?.rawPrefix).not.toContain("ZZEND");
    expect(signature?.rawPrefix).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
