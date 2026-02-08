import { describe, expect, it } from "vitest";
import { createAnalyzer } from "./analyzer.js";

describe("conductor analyzer (regex)", () => {
  const analyzer = createAnalyzer({ provider: "regex" });

  it("detects URL visit requests", async () => {
    const result = await analyzer.analyze(
      "Please go to https://example.com/dashboard to check the status",
    );
    expect(result.detected).toBe(true);
    expect(result.request?.kind).toBe("url-visit");
    expect(result.request?.url).toBe("https://example.com/dashboard");
  });

  it("detects credential fetch requests", async () => {
    const result = await analyzer.analyze("I need to get the API key from Railway");
    expect(result.detected).toBe(true);
    expect(result.request?.kind).toBe("credential-fetch");
  });

  it("detects service action requests", async () => {
    const result = await analyzer.analyze("Go to the Vercel dashboard to check deploy status");
    expect(result.detected).toBe(true);
    expect(result.request?.kind).toBe("service-action");
  });

  it("returns no detection for normal output", async () => {
    const result = await analyzer.analyze("Building project... Done in 2.3s");
    expect(result.detected).toBe(false);
  });

  it("handles ANSI escape codes", async () => {
    const result = await analyzer.analyze("\x1B[32mPlease visit https://test.dev/api\x1B[0m");
    expect(result.detected).toBe(true);
    expect(result.request?.url).toBe("https://test.dev/api");
  });

  it("skips very short output with gemini provider (no key)", async () => {
    // With no API key, gemini falls back to regex
    const geminiAnalyzer = createAnalyzer({ provider: "gemini" });
    const result = await geminiAnalyzer.analyze("ok");
    expect(result.detected).toBe(false);
  });
});
