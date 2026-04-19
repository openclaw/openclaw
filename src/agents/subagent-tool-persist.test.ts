import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { emitSessionTranscriptUpdateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  emitSessionTranscriptUpdateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));
vi.mock("../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: emitSessionTranscriptUpdateMock,
}));
vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: (...args: unknown[]) => sessionManagerOpenMock(...args),
  },
}));

import {
  persistSubagentToolResult,
  persistSubagentToolUse,
  TOOL_RESULT_SUMMARY_KIND,
  TOOL_SUMMARY_KIND,
} from "./subagent-tool-persist.js";
import { REDACT_TOKEN } from "./subagent-tool-redact.js";

function makeManager() {
  const calls: unknown[] = [];
  return {
    calls,
    appendMessage(message: unknown) {
      calls.push(message);
      return "entry-id";
    },
  };
}

describe("persistSubagentToolUse", () => {
  let tmpFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    emitSessionTranscriptUpdateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    originalEnv = process.env.SUBAGENT_PERSIST_TOOL_FRAGMENTS;
    delete process.env.SUBAGENT_PERSIST_TOOL_FRAGMENTS;
    tmpFile = path.join(os.tmpdir(), `tool-persist-${Date.now()}-${Math.random()}.jsonl`);
    fs.writeFileSync(tmpFile, "");
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SUBAGENT_PERSIST_TOOL_FRAGMENTS = originalEnv;
    } else {
      delete process.env.SUBAGENT_PERSIST_TOOL_FRAGMENTS;
    }
    try {
      fs.rmSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("appends a tool_summary assistant message with redacted input", () => {
    const mgr = makeManager();
    sessionManagerOpenMock.mockReturnValue(mgr);

    const ok = persistSubagentToolUse({
      sessionFile: tmpFile,
      sessionKey: "agent:builder:x",
      toolName: "WebFetch",
      input: { url: "https://example.com", api_key: "abc123xyz" },
    });
    expect(ok).toBe(true);
    expect(mgr.calls).toHaveLength(1);
    const appended = mgr.calls[0] as Record<string, unknown>;
    expect(appended.role).toBe("assistant");
    const meta = appended.__openclaw as Record<string, unknown>;
    expect(meta.kind).toBe(TOOL_SUMMARY_KIND);
    expect(meta.toolName).toBe("WebFetch");
    const text = (appended.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("[tool: WebFetch]");
    expect(text).toContain(REDACT_TOKEN);
    expect(text).not.toContain("abc123xyz");
  });

  it("appends a tool_result_summary with redacted result and the 500-char cap", () => {
    const mgr = makeManager();
    sessionManagerOpenMock.mockReturnValue(mgr);

    const longResult = `Authorization: Bearer sk-xyz-123\n${"z".repeat(1000)}`;
    const ok = persistSubagentToolResult({
      sessionFile: tmpFile,
      text: longResult,
    });
    expect(ok).toBe(true);
    const appended = mgr.calls[0] as Record<string, unknown>;
    const meta = appended.__openclaw as Record<string, unknown>;
    expect(meta.kind).toBe(TOOL_RESULT_SUMMARY_KIND);
    const text = (appended.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text.startsWith("[result] ")).toBe(true);
    expect(text).toContain(REDACT_TOKEN);
    expect(text).not.toContain("sk-xyz-123");
    // [result] (9) + 500 cap + ellipsis
    expect(text.length).toBeLessThanOrEqual("[result] ".length + 500 + 1);
  });

  it("is a no-op when SUBAGENT_PERSIST_TOOL_FRAGMENTS=0", () => {
    process.env.SUBAGENT_PERSIST_TOOL_FRAGMENTS = "0";
    const mgr = makeManager();
    sessionManagerOpenMock.mockReturnValue(mgr);
    expect(
      persistSubagentToolUse({
        sessionFile: tmpFile,
        toolName: "Bash",
        input: { command: "date" },
      }),
    ).toBe(false);
    expect(
      persistSubagentToolResult({
        sessionFile: tmpFile,
        text: "hi",
      }),
    ).toBe(false);
    expect(mgr.calls).toHaveLength(0);
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("is a no-op when sessionFile is missing", () => {
    const mgr = makeManager();
    sessionManagerOpenMock.mockReturnValue(mgr);
    expect(persistSubagentToolUse({ sessionFile: undefined, toolName: "Bash", input: {} })).toBe(
      false,
    );
    expect(persistSubagentToolUse({ sessionFile: "", toolName: "Bash", input: {} })).toBe(false);
    expect(persistSubagentToolResult({ sessionFile: "", text: "x" })).toBe(false);
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("swallows SessionManager errors and returns false (best-effort write)", () => {
    sessionManagerOpenMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(
      persistSubagentToolUse({
        sessionFile: tmpFile,
        toolName: "Bash",
        input: { command: "date" },
      }),
    ).toBe(false);
  });
});
