import { describe, expect, it } from "vitest";
import { createParitySessionFixture } from "./runtime-parity-session.test-helper.js";
import { captureRuntimeParityCell } from "./runtime-parity.js";

const seedSession = createParitySessionFixture();

function toolEvents(
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  success: boolean,
) {
  const tool = { toolCallId: `${name.replaceAll("_", "-")}-1`, name };
  return [
    { type: "tool.call", data: { ...tool, arguments: args } },
    {
      type: "tool.result",
      data: { ...tool, status: success ? "completed" : "failed", success, result },
    },
  ];
}

function captureSession(tempRoot: string, sessionKey: string) {
  return captureRuntimeParityCell({
    runtime: "codex",
    gateway: { tempRoot },
    scenarioResult: { status: "pass", details: `RUNTIME_PARITY_SESSION_KEY=${sessionKey}` },
    wallClockMs: 10,
  });
}

describe("runtime parity session selection", () => {
  it("keeps fixture-owned tool sessions when Codex attaches parent metadata", async () => {
    const now = Date.now();
    const rootSessionKey = "agent:qa:unrelated-root";
    const tempRoot = await seedSession({
      sessionId: "unrelated-root",
      sessionKey: rootSessionKey,
      messages: [{ role: "assistant", content: "Setup complete." }],
      updatedAt: now,
    });
    await seedSession({
      tempRoot,
      sessionId: "web-fetch-fixture",
      sessionKey: "agent:qa:runtime-tool:web_fetch:failure",
      parentSessionKey: rootSessionKey,
      messages: [{ role: "user", content: "failure target=web_fetch" }],
      updatedAt: now - 1_000,
      trajectoryEvents: toolEvents(
        "web_fetch",
        { __qaFailureMode: "denied-input" },
        { error: "url required" },
        false,
      ),
    });

    const cell = await captureSession(tempRoot, "agent:qa:runtime-tool:web_fetch:failure");

    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "web_fetch" })]);
  });

  it("retains parent sessions_spawn evidence when the spawned child is newer", async () => {
    const now = Date.now();
    const parentSessionKey = "agent:qa:runtime-tool:sessions_spawn:happy";
    const tempRoot = await seedSession({
      sessionId: "sessions-spawn-parent",
      sessionKey: parentSessionKey,
      messages: [{ role: "user", content: "tool search qa check target=sessions_spawn" }],
      updatedAt: now - 1_000,
      trajectoryEvents: toolEvents(
        "sessions_spawn",
        { task: "reply exactly RUNTIME-TOOL-FIXTURE", mode: "run" },
        { status: "accepted", childSessionKey: "agent:qa:subagent:child" },
        true,
      ),
    });
    await seedSession({
      tempRoot,
      sessionId: "sessions-spawn-child",
      sessionKey: "agent:qa:subagent:child",
      parentSessionKey,
      messages: [{ role: "assistant", content: "RUNTIME-TOOL-FIXTURE" }],
      updatedAt: now,
    });

    const cell = await captureSession(tempRoot, parentSessionKey);

    expect(cell.transcriptBytes).toContain("target=sessions_spawn");
    expect(cell.transcriptBytes).not.toContain("RUNTIME-TOOL-FIXTURE");
    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "sessions_spawn" })]);
    expect(cell.toolCalls[0]).not.toHaveProperty("errorClass");
    expect(cell.toolCalls[0]?.resultHash).not.toBe("");
  });
});
