import { describe, expect, it } from "vitest";
import type { MediaFact } from "../../media/media-facts.js";
import { readMediaBuffer } from "../../media/store.js";
import { fitOversizedCurrentInput, resolveCurrentInputMaxChars } from "./current-input-budget.js";

// Shape of a hook agent message: instruction, opening untrusted-content marker,
// a large body, the closing marker, then trailing run guidance.
const instruction = "Reply with exactly ZEBRA-4217.";
const prompt =
  `${instruction}\n<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\n${"b".repeat(20_000)}` +
  `\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\nCollect results in this turn.`;

describe("current input budget", () => {
  it("takes the smaller of the runtime cap and most of the model window", () => {
    // 258,400 tokens x 0.9 x 3 chars stays below the 1 MiB Codex cap.
    expect(resolveCurrentInputMaxChars({ runtimeMaxChars: 1 << 20, contextTokens: 258_400 })).toBe(
      697_680,
    );
    expect(
      resolveCurrentInputMaxChars({ runtimeMaxChars: 1 << 20, contextTokens: 1_050_000 }),
    ).toBe(1 << 20);
    expect(resolveCurrentInputMaxChars({ contextTokens: 258_400 })).toBe(697_680);
    expect(resolveCurrentInputMaxChars({})).toBeUndefined();
  });

  it("attaches the complete request and keeps its instruction and both markers inline", async () => {
    let staged: MediaFact[] = [];
    const fitted = await fitOversizedCurrentInput({
      prompt,
      maxChars: 2_000,
      stageAttachment: async (media) => {
        staged = media;
        return "ATTACHMENT-PATHS-NOTE";
      },
    });

    expect(fitted.length).toBeLessThanOrEqual(2_000);
    expect(fitted).toContain(instruction);
    expect(fitted).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>');
    expect(fitted).toContain("Collect results in this turn.");
    expect(fitted).toContain("The complete request is attached as current-request.txt");
    expect(fitted.endsWith("ATTACHMENT-PATHS-NOTE")).toBe(true);
    const id = staged[0]?.path?.replace("media://inbound/", "");
    expect(staged[0]).toMatchObject({ contentType: "text/plain", kind: "document" });
    expect((await readMediaBuffer(id ?? "")).buffer.toString("utf8")).toBe(prompt);
  });

  it("cuts only the middle when the run cannot read an attachment", async () => {
    const fitted = await fitOversizedCurrentInput({
      prompt,
      maxChars: 2_000,
      stageAttachment: async () => undefined,
    });

    expect(fitted.length).toBeLessThanOrEqual(2_000);
    expect(fitted).toContain(instruction);
    expect(fitted).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>');
    expect(fitted).toContain("Collect results in this turn.");
    expect(fitted).toMatch(/\[truncated \d+ chars from the middle of the current request\]/);
  });
});
