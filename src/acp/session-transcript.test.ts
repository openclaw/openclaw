import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveSessionTranscriptFileMock: vi.fn(),
  warnMock: vi.fn(),
  emitSessionTranscriptUpdateMock: vi.fn(),
}));

vi.mock("../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/transcript.js")>();
  return {
    ...actual,
    resolveSessionTranscriptFile: (params: unknown) =>
      hoisted.resolveSessionTranscriptFileMock(params),
  };
});

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "acp/session-transcript",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: hoisted.warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

vi.mock("../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: hoisted.emitSessionTranscriptUpdateMock,
}));

const { persistAcpPromptTranscript, persistAcpTurnTranscript } =
  await import("./session-transcript.js");

function readTranscriptMessages(sessionFile: string): AgentMessage[] {
  return SessionManager.open(sessionFile)
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= 1_000) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("ACP session transcript persistence", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    hoisted.warnMock.mockReset();
    hoisted.emitSessionTranscriptUpdateMock.mockReset();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps the seeded sessions_spawn prompt when the ACP turn later persists the same task", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-1.jsonl");
    const sessionEntry = {
      sessionId: "sess-1",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:main:main",
      sourceChannel: "discord",
      sourceTool: "sessions_spawn",
    };

    await persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-1",
      sessionKey: "agent:codex:acp:1",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance,
    });

    await persistAcpTurnTranscript({
      body: "[Thu 2026-03-12 10:00 UTC] Investigate flaky tests",
      finalText: "I checked the failing run.",
      sessionId: "sess-1",
      sessionKey: "agent:codex:acp:1",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance,
    });

    const messages = readTranscriptMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Investigate flaky tests",
      provenance: {
        kind: "inter_session",
        sourceTool: "sessions_spawn",
      },
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I checked the failing run." }],
    });
  });

  it("does not collapse a later identical prompt from a different provenance", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-2.jsonl");
    const sessionEntry = {
      sessionId: "sess-2",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));

    await persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-2",
      sessionKey: "agent:codex:acp:2",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceTool: "sessions_spawn",
      },
    });

    await persistAcpTurnTranscript({
      body: "[Thu 2026-03-12 10:00 UTC] Investigate flaky tests",
      finalText: "",
      sessionId: "sess-2",
      sessionKey: "agent:codex:acp:2",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance: undefined,
    });

    const messages = readTranscriptMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
  });

  it("records later prompt-only retries after the seeded replay dedupe window is consumed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-retry.jsonl");
    const sessionEntry = {
      sessionId: "sess-retry",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:main:main",
      sourceChannel: "discord",
      sourceTool: "sessions_spawn",
    };

    await persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-retry",
      sessionKey: "agent:codex:acp:retry",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance,
    });

    await persistAcpTurnTranscript({
      body: "[Thu 2026-03-12 10:00 UTC] Investigate flaky tests",
      finalText: "",
      sessionId: "sess-retry",
      sessionKey: "agent:codex:acp:retry",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance,
    });

    expect(readTranscriptMessages(sessionFile)).toHaveLength(1);

    await persistAcpTurnTranscript({
      body: "[Thu 2026-03-12 10:05 UTC] Investigate flaky tests",
      finalText: "",
      sessionId: "sess-retry",
      sessionKey: "agent:codex:acp:retry",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
      inputProvenance,
    });

    const messages = readTranscriptMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
  });

  it("preserves interrupted prompt-only history when a later ACP turn adds an assistant reply", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-interrupted.jsonl");
    const sessionEntry = {
      sessionId: "sess-interrupted",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));

    await persistAcpTurnTranscript({
      body: "first prompt",
      finalText: "",
      sessionId: "sess-interrupted",
      sessionKey: "agent:codex:acp:interrupted",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
    });

    await persistAcpTurnTranscript({
      body: "second prompt",
      finalText: "assistant reply",
      sessionId: "sess-interrupted",
      sessionKey: "agent:codex:acp:interrupted",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
    });

    const messages = readTranscriptMessages(sessionFile);
    expect(messages).toHaveLength(3);
    expect(messages).toMatchObject([
      { role: "user", content: "first prompt" },
      { role: "user", content: "second prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant reply" }],
      },
    ]);
  });

  it("flushes prompt-only transcripts even when SessionManager.isPersisted is unavailable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-3.jsonl");
    const sessionEntry = {
      sessionId: "sess-3",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));

    const realManager = SessionManager.open(sessionFile);
    const rewriteSpy = vi.fn();
    (
      realManager as unknown as {
        isPersisted?: undefined;
        _rewriteFile?: () => void;
      }
    ).isPersisted = undefined;
    (
      realManager as unknown as {
        _rewriteFile?: () => void;
      }
    )._rewriteFile = rewriteSpy;

    vi.spyOn(SessionManager, "open").mockReturnValue(realManager);

    await persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-3",
      sessionKey: "agent:codex:acp:3",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
    });

    expect(rewriteSpy).toHaveBeenCalledOnce();
    expect(hoisted.warnMock).not.toHaveBeenCalled();
  });

  it("warns when the SessionManager private flush hook is unavailable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-4.jsonl");
    const sessionEntry = {
      sessionId: "sess-4",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));

    const realManager = SessionManager.open(sessionFile);
    (
      realManager as unknown as {
        isPersisted?: () => boolean;
        _rewriteFile?: undefined;
      }
    ).isPersisted = () => true;
    (
      realManager as unknown as {
        _rewriteFile?: undefined;
      }
    )._rewriteFile = undefined;

    vi.spyOn(SessionManager, "open").mockReturnValue(realManager);

    await persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-4",
      sessionKey: "agent:codex:acp:4",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
    });

    expect(hoisted.warnMock).toHaveBeenCalledWith(
      "ACP prompt-only transcript flush skipped because SessionManager._rewriteFile is unavailable",
    );
  });

  it("waits for an async SessionManager private flush hook before emitting transcript updates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-transcript-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "sess-5.jsonl");
    const sessionEntry = {
      sessionId: "sess-5",
      updatedAt: Date.now(),
      sessionFile,
    };
    hoisted.resolveSessionTranscriptFileMock.mockReset().mockImplementation(async () => ({
      sessionFile,
      sessionEntry,
    }));

    let resolveRewrite: (() => void) | undefined;
    const rewritePromise = new Promise<void>((resolve) => {
      resolveRewrite = resolve;
    });
    const realManager = SessionManager.open(sessionFile);
    (
      realManager as unknown as {
        isPersisted?: () => boolean;
        _rewriteFile?: () => Promise<void>;
      }
    ).isPersisted = () => true;
    const rewriteSpy = vi.fn(() => rewritePromise);
    (
      realManager as unknown as {
        _rewriteFile?: () => Promise<void>;
      }
    )._rewriteFile = rewriteSpy;

    vi.spyOn(SessionManager, "open").mockReturnValue(realManager);

    const persistPromise = persistAcpPromptTranscript({
      promptText: "Investigate flaky tests",
      sessionId: "sess-5",
      sessionKey: "agent:codex:acp:5",
      sessionEntry,
      sessionAgentId: "codex",
      sessionCwd: tempDir,
    });

    await waitForAssertion(() => {
      expect(rewriteSpy).toHaveBeenCalledOnce();
    });
    expect(hoisted.emitSessionTranscriptUpdateMock).not.toHaveBeenCalled();

    resolveRewrite?.();
    await persistPromise;

    expect(hoisted.emitSessionTranscriptUpdateMock).toHaveBeenCalledWith(sessionFile);
  });
});
