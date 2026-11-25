import { describe, expect, it } from "vitest";
import type { MediaFact } from "../../media/media-facts.js";
import { readMediaBuffer } from "../../media/store.js";
import { fitOversizedCurrentInput } from "./current-input-budget.js";

// Shape of a hook agent message: instruction, opening untrusted-content marker,
// a large body, the closing marker, then trailing run guidance.
const instruction = "Reply with exactly ZEBRA-4217.";
const prompt =
  `${instruction}\n<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\n${"b".repeat(20_000)}` +
  `\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\nCollect results in this turn.`;

function expectInstructionAndMarkers(fitted: string) {
  expect(fitted.length).toBeLessThanOrEqual(2_000);
  expect(fitted).toContain(instruction);
  expect(fitted).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>');
  expect(fitted).toContain("Collect results in this turn.");
}

describe("fitOversizedCurrentInput", () => {
  it("keeps a request within the cap unchanged", async () => {
    await expect(fitOversizedCurrentInput({ prompt, maxChars: prompt.length })).resolves.toBe(
      prompt,
    );
  });

  it("attaches the complete request and keeps its instruction and both markers inline", async () => {
    let staged: MediaFact[] = [];
    const fitted = await fitOversizedCurrentInput({
      prompt,
      maxChars: 2_000,
      stageAttachment: async (_noteMaxChars, media) => {
        staged = media;
        return "ATTACHMENT-PATHS-NOTE";
      },
    });

    expectInstructionAndMarkers(fitted);
    expect(fitted).toContain("The complete request is attached as current-request.txt");
    expect(fitted.endsWith("ATTACHMENT-PATHS-NOTE")).toBe(true);
    const id = staged[0]?.path?.replace("media://inbound/", "");
    expect(staged[0]).toMatchObject({ contentType: "text/plain", kind: "document" });
    expect((await readMediaBuffer(id ?? "")).buffer.toString("utf8")).toBe(prompt);
  });

  it("cuts only the middle when the runtime cannot read an attachment", async () => {
    const fitted = await fitOversizedCurrentInput({
      prompt,
      maxChars: 2_000,
      stageAttachment: async () => undefined,
    });

    expectInstructionAndMarkers(fitted);
    expect(fitted).toMatch(/\[truncated \d+ chars from the middle of the current request\]/);
  });
});
