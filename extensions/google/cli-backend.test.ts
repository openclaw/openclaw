import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliBackend } from "./test-api.js";

describe("google gemini cli backend", () => {
  it("configures flash-lite shorthand to the bare Gemini 3.1 Flash-Lite id", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.config.modelAliases?.["flash-lite"]).toBe("gemini-3.1-flash-lite");
  });
});
