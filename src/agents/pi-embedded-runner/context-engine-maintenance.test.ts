import { beforeEach, describe, expect, it, vi } from "vitest";

const rewriteTranscriptEntriesInSessionManagerMock = vi.fn((_params?: unknown) => ({
  changed: true,
  bytesFreed: 77,
  rewrittenEntries: 1,
}));
const rewriteTranscriptEntriesInSessionFileMock = vi.fn(async (_params?: unknown) => ({
  changed: true,
  bytesFreed: 123,
  rewrittenEntries: 2,
}));
let buildContextEngineMaintenanceRuntimeContext: typeof import("./context-engine-maintenance.js").buildContextEngineMaintenanceRuntimeContext;
let runContextEngineMaintenance: typeof import("./context-engine-maintenance.js").runContextEngineMaintenance;

vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionManager: (params: unknown) =>
    rewriteTranscriptEntriesInSessionManagerMock(params),
  rewriteTranscriptEntriesInSessionFile: (params: unknown) =>
    rewriteTranscriptEntriesInSessionFileMock(params),
}));

async function loadFreshContextEngineMaintenanceModuleForTest() {
  vi.resetModules();
  ({ buildContextEngineMaintenanceRuntimeContext, runContextEngineMaintenance } =
    await import("./context-engine-maintenance.js"));
}

describe("buildContextEngineMaintenanceRuntimeContext", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("adds a transcript rewrite helper that targets the current session file", async () => {
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      runtimeContext: { workspaceDir: "/tmp/workspace" },
    });

    expect(runtimeContext.workspaceDir).toBe("/tmp/workspace");
    expect(typeof runtimeContext.rewriteTranscriptEntries).toBe("function");

    const result = await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      changed: true,
      bytesFreed: 123,
      rewrittenEntries: 2,
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      request: {
        replacements: [
          { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
        ],
      },
    });
  });

  it("reuses the active session manager when one is provided", async () => {
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      sessionManager,
    });

    const result = await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      changed: true,
      bytesFreed: 77,
      rewrittenEntries: 1,
    });
    expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
      sessionManager,
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
  });
});

describe("runContextEngineMaintenance", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("passes a rewrite-capable runtime context into maintain()", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));

    const result = await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain,
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      reason: "turn",
      runtimeContext: { workspaceDir: "/tmp/workspace" },
    });

    expect(result).toEqual({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    });
    expect(maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "/tmp/session.jsonl",
        runtimeContext: expect.objectContaining({
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
    const runtimeContext = (
      maintain.mock.calls[0]?.[0] as
        | { runtimeContext?: { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> } }
        | undefined
    )?.runtimeContext as
      | { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> }
      | undefined;
    expect(typeof runtimeContext?.rewriteTranscriptEntries).toBe("function");
  });
});
