import { describe, expect, it } from "vitest";
import { normalizeCliModel } from "../../src/agents/cli-runner/helpers.js";
import { buildGoogleGeminiCliBackend } from "./test-api.js";

describe("google gemini cli backend", () => {
  it("maps flash-lite shorthand to the bare Gemini 3.1 Flash-Lite id", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(normalizeCliModel("flash-lite", backend.config)).toBe("gemini-3.1-flash-lite");
  });
});
