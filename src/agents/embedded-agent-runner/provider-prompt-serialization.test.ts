import { hash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";

const sha = (v: unknown) => hash("sha256", JSON.stringify(v));
const bin = (v: unknown) => hash("sha256", JSON.stringify(v), "latin1");
const prep = (payload: Record<string, unknown>) =>
  prepareProviderPrompt({ payload, encode: true }).cachePrefix;

describe("prepareProviderPrompt for Vertex/Gemini wire payloads", () => {
  it("extracts Vertex fields without leaking content and isolates maxOutputTokens", () => {
    const gcBase = { temperature: 0.2, thinkingConfig: { includeThoughts: true } };
    const toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    const cachedContent = "cachedContents/private-handle";
    const params = {
      generationConfig: { ...gcBase, maxOutputTokens: 8192 },
      toolConfig,
      cachedContent,
    };
    const c0 = { role: "user", parts: [{ text: "private turn 1" }] };
    const c1 = { role: "model", parts: [{ text: "private reply 1" }] };
    const sys = { parts: [{ text: "private system" }] };
    const tools = [{ functionDeclarations: [{ name: "private_tool" }] }];
    const prefix = prep({ systemInstruction: sys, tools, contents: [c0, c1], ...params });
    const fields = {
      generationConfig: sha(gcBase),
      "generationConfig.maxOutputTokens": sha(8192),
      toolConfig: sha(toolConfig),
      cachedContent: sha(cachedContent),
    };
    expect(prefix).toEqual({
      system: sha({ systemInstruction: sys }),
      tools: sha({ tools }),
      messageDigests: bin(c0) + bin(c1),
      messageFields: [c0, c1].map((c) => ({ role: sha(c.role), parts: sha(c.parts) })),
      messageField: "contents",
      messageCount: 2,
      parameters: { digest: bin(params), fields },
      continuation: false,
    });
    expect(JSON.stringify(prefix)).not.toContain("private");
    const min = { systemInstruction: sys, contents: [c0] };
    const cap = prep({ ...min, generationConfig: { maxOutputTokens: 4096 } });
    expect(cap?.parameters.fields).toEqual({ "generationConfig.maxOutputTokens": sha(4096) });
    expect(prep(min)?.parameters.fields).toEqual({});
  });
});
