import { describe, expect, it, vi } from "vitest";
import { createParitySessionFixture } from "./runtime-parity-session.test-helper.js";
import { captureRuntimeParityCell } from "./runtime-parity.js";

const seedSession = createParitySessionFixture();

async function captureForcedCodexCell(
  sessionId: string,
  assistant?: Record<string, unknown>,
  logs?: () => string,
) {
  const tempRoot = await seedSession({
    sessionId,
    sessionKey: `agent:qa:${sessionId}`,
    sequenceMessageTimes: true,
    messages: [
      { role: "user", content: "runtime isolation check" },
      ...(assistant ? [assistant] : []),
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
  return captureRuntimeParityCell({
    runtime: "codex",
    gateway: { tempRoot, ...(logs ? { logs } : {}) },
    mockBaseUrl: "http://127.0.0.1:43123",
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
  });
}

describe("runtime parity forced runtime observer", () => {
  it("ignores Codex mirror records and shared logs without an OpenClaw selection", async () => {
    const cell = await captureForcedCodexCell(
      "forced-codex-embedded-runtime",
      {
        role: "assistant",
        content: [{ type: "text", text: "Codex mirror" }],
        provider: "openai",
        api: "openai-responses",
        stopReason: "stop",
        __openclaw: { mirrorOrigin: "codex-app-server" },
      },
      () => "[agent/embedded] fallback runner entered",
    );

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("fails a forced-Codex mock cell that selects the OpenClaw fallback", async () => {
    const cell = await captureForcedCodexCell(
      "forced-codex-openclaw-selection",
      undefined,
      () =>
        "agent harness selected requested=codex selected=openclaw reason=plugin_declared_fallback_openclaw",
    );

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });

  it("fails a forced-Codex mock cell containing any unmirrored Responses record", async () => {
    const cell = await captureForcedCodexCell("forced-codex-openai-egress", {
      role: "assistant",
      content: [],
      provider: "openai",
      api: "openai-responses",
      stopReason: "stop",
    });

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });
});
