import { describe, expect, it } from "vitest";
import { describeProviderPrefix } from "./prompt-cache-provider-prefix.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import type { ProviderPromptState } from "./provider-prompt-state.js";

const att = (payload: Record<string, unknown>) => {
  const { encoded: _e, ...prepared } = prepareProviderPrompt({ payload, encode: true });
  return { scopeDigest: "vertex-scope", ...prepared } as ProviderPromptState["lastAttempt"];
};
const c0 = { role: "user", parts: [{ text: "u1" }] };
const c1 = { role: "model", parts: [{ text: "m1" }] };
const gc = { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { includeThoughts: true } };
const wire = (ov: Record<string, unknown> = {}) => ({
  systemInstruction: { parts: [{ text: "sys" }] },
  tools: [{ functionDeclarations: [{ name: "exec" }, { name: "read" }] }],
  contents: [c0, c1],
  generationConfig: gc,
  toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  ...ov,
});

describe("describeProviderPrefix for Vertex payloads", () => {
  it("classifies prefix-match, maxOutputTokens-only, system, tools, parts, params, and format", () => {
    const first = att(wire());
    const gcHot = { ...gc, temperature: 0.9, maxOutputTokens: 4096 };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ contents: [c0, c1, { role: "user", parts: [{ text: "u2" }] }] }, "prefix-match"],
      [{ generationConfig: { ...gc, maxOutputTokens: 2048 } }, "prefix-match"],
      [{ systemInstruction: { parts: [{ text: "changed" }] } }, "system"],
      [{ tools: [{ functionDeclarations: [{ name: "alpha" }, { name: "exec" }] }] }, "tools"],
      [{ contents: [c0, { role: "model", parts: [{ text: "rewritten" }] }] }, "message:1.parts"],
      [{ generationConfig: gcHot }, "parameters:generationConfig"],
      [{ toolConfig: { functionCallingConfig: { mode: "ANY" } } }, "parameters:toolConfig"],
      [{ cachedContent: "cachedContents/new" }, "parameters:cachedContent"],
    ];
    for (const [ov, expected] of cases) {
      expect(describeProviderPrefix(first, att(wire(ov)))).toBe(expected);
    }
    const cap = att(wire({ generationConfig: { maxOutputTokens: 8192 } }));
    const noGc = att(wire({ generationConfig: undefined }));
    expect(describeProviderPrefix(cap, noGc)).toBe("prefix-match");
    const { contents: _c, ...rest } = wire();
    const swapped = att({ ...rest, messages: [{ role: "user", content: "x" }] });
    expect(describeProviderPrefix(first, swapped)).toContain("input-format");
  });
});
