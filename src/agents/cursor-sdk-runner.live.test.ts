import { describe, expect, it } from "vitest";

const LIVE_ENABLED = process.env.OPENCLAW_LIVE_CURSOR_SDK === "1";

describe.skipIf(!LIVE_ENABLED)("cursor-sdk-runner (live)", () => {
  it("sends a prompt and receives a text response", { timeout: 150_000 }, async () => {
    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    const result = await runCursorSdkAgent({
      sessionId: `live-test-${Date.now()}`,
      sessionFile: "/tmp/cursor-sdk-live-test.json",
      workspaceDir: process.cwd(),
      prompt:
        "Reply with exactly the text 'CURSOR_SDK_LIVE_OK' and nothing else. Do not use markdown.",
      provider: "cursor-sdk",
      model: "composer-2",
      timeoutMs: 120_000,
      runId: `live-run-${Date.now()}`,
    });

    expect(result).toBeDefined();
    expect(result.meta.durationMs).toBeGreaterThan(0);
    expect(result.meta.agentMeta?.provider).toBe("cursor-sdk");
    expect(result.payloads).toBeDefined();
    expect(result.payloads!.length).toBeGreaterThan(0);
    const text = result.payloads![0]!.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    console.log(`[live-test] response text (${text.length} chars): ${text.slice(0, 200)}`);
  });
});
