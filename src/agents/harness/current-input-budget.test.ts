import { describe, expect, it } from "vitest";
import type { MediaFact } from "../../media/media-facts.js";
import { readMediaBuffer } from "../../media/store.js";
import { fitOversizedCurrentInput, resolveCurrentInputBudget } from "./current-input-budget.js";

// Shape of a hook agent message: instruction, opening untrusted-content marker,
// a large body, the closing marker, then trailing run guidance.
const instruction = "Reply with exactly ZEBRA-4217.";
const prompt =
  `${instruction}\n<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\n${"b".repeat(20_000)}` +
  `\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a1">>>\nCollect results in this turn.`;
const budget = { attachMaxChars: 2_000, cutMaxChars: 4_000 };

describe("current input budget", () => {
  it("bounds both limits by the runtime cap and the model window", () => {
    expect(resolveCurrentInputBudget({ runtimeMaxChars: 1 << 20, contextTokens: 258_400 })).toEqual(
      {
        attachMaxChars: 697_680,
        cutMaxChars: 904_400,
      },
    );
    expect(
      resolveCurrentInputBudget({ runtimeMaxChars: 1 << 20, contextTokens: 1_050_000 }),
    ).toEqual({ attachMaxChars: 1 << 20, cutMaxChars: 1 << 20 });
    expect(resolveCurrentInputBudget({})).toBeUndefined();
  });

  it("attaches the complete request and keeps its instruction and both markers inline", async () => {
    let staged: MediaFact[] = [];
    const fitted = await fitOversizedCurrentInput({
      prompt,
      budget,
      stageAttachment: async (_noteMaxChars, media) => {
        staged = media;
        return "ATTACHMENT-PATHS-NOTE";
      },
    });

    expect(fitted.length).toBeLessThanOrEqual(budget.attachMaxChars);
    expect(fitted).toContain(instruction);
    expect(fitted).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>');
    expect(fitted).toContain("Collect results in this turn.");
    expect(fitted).toContain("The complete request is attached as current-request.txt");
    expect(fitted.endsWith("ATTACHMENT-PATHS-NOTE")).toBe(true);
    const id = staged[0]?.path?.replace("media://inbound/", "");
    expect(staged[0]).toMatchObject({ contentType: "text/plain", kind: "document" });
    expect((await readMediaBuffer(id ?? "")).buffer.toString("utf8")).toBe(prompt);
  });

  it("cuts only a request that cannot fit when no attachment is readable", async () => {
    const fits = "x".repeat(3_000);
    await expect(fitOversizedCurrentInput({ prompt: fits, budget })).resolves.toBe(fits);

    const fitted = await fitOversizedCurrentInput({
      prompt,
      budget,
      stageAttachment: async () => undefined,
    });
    expect(fitted.length).toBeLessThanOrEqual(budget.cutMaxChars);
    expect(fitted).toContain(instruction);
    expect(fitted).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="a1">>>');
    expect(fitted).toContain("Collect results in this turn.");
    expect(fitted).toMatch(/\[truncated \d+ chars from the middle of the current request\]/);
  });
});
