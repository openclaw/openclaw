// Regression test for Bug #5: provider/model fallback in persistCliTurnTranscript
import { describe, it, expect, vi } from "vitest";

const captured: Array<{ provider?: string; model?: string; api?: string }> = [];

vi.mock("../../config/sessions/session-accessor.js", () => ({
  persistSessionTranscriptTurn: vi.fn(async (_sessionInfo: unknown, options: { messages?: Array<{ message?: { provider?: string; model?: string; api?: string; role?: string } }> }) => {
    for (const m of options.messages ?? []) {
      if (m.message?.role === "assistant") {
        captured.push({
          provider: m.message.provider,
          model: m.message.model,
          api: m.message.api,
        });
      }
    }
    return { kind: "persisted" as const, sessionFile: "/tmp/mock-session.json", appended: true, rejectedReason: undefined, sessionEntry: undefined };
  }),
  loadSessionEntry: vi.fn(async () => undefined),
  patchSessionEntry: vi.fn(async () => undefined),
  listSessionEntries: vi.fn(async () => []),
}));

vi.mock("../../config/sessions/transcript.js", () => ({
  readTailAssistantTextFromSessionTranscript: vi.fn(async () => null),
}));

vi.mock("../../infra/node-sqlite.js", () => ({
  requireNodeSqlite: () => {
    throw new Error("SQLite mocked out");
  },
}));

const { persistCliTurnTranscript } = await import("./attempt-execution.js");

describe("Bug #5 - persistCliTurnTranscript provider/model fallback", () => {
  it("uses cli and default when provider and model are empty/whitespace", async () => {
    captured.length = 0;
    await persistCliTurnTranscript({
      body: "test",
      result: { meta: { agentMeta: { provider: "   ", model: "" }, finalAssistantVisibleText: "reply" } } as never,
      sessionId: "s1",
      sessionKey: "agent:main:s1",
      sessionEntry: undefined,
      sessionAgentId: "main",
      sessionCwd: "/tmp",
      config: {} as never,
    });
    expect(captured[0]?.provider).toBe("cli");
    expect(captured[0]?.model).toBe("default");
  });

  it("uses actual provider and model when non-empty", async () => {
    captured.length = 0;
    await persistCliTurnTranscript({
      body: "test",
      result: { meta: { agentMeta: { provider: "anthropic", model: "claude-3" }, finalAssistantVisibleText: "reply" } } as never,
      sessionId: "s1",
      sessionKey: "agent:main:s1",
      sessionEntry: undefined,
      sessionAgentId: "main",
      sessionCwd: "/tmp",
      config: {} as never,
    });
    expect(captured[0]?.provider).toBe("anthropic");
    expect(captured[0]?.model).toBe("claude-3");
  });
});
