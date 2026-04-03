import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionScopedFieldsOnSessionIdRollover,
  resolveFallbackRetryPrompt,
  sessionFileHasContent,
} from "./attempt-execution.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("returns original body on first attempt (isFallbackRetry=false)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry with existing session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry when session has no history (subagent spawn)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry when sessionHasHistory is undefined", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
      }),
    ).toBe(originalBody);
  });

  it("returns original body on first attempt regardless of sessionHasHistory", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
      }),
    ).toBe(originalBody);

    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body on fallback retry without history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("uses the recovery prompt only when the fallback body is empty", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "",
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");

    expect(
      resolveFallbackRetryPrompt({
        body: "   ",
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });
});

describe("clearSessionScopedFieldsOnSessionIdRollover", () => {
  it("clears session-scoped continuity fields when the session id changes", () => {
    expect(
      clearSessionScopedFieldsOnSessionIdRollover(
        {
          sessionId: "old-session",
          updatedAt: 100,
          sessionFile: "/tmp/old-session.jsonl",
          cliSessionIds: { "github-copilot": "cli-old" },
          systemPromptReport: { warnings: ["stale"] },
          abortedLastRun: true,
          thinkingLevel: "high",
        },
        {
          sessionId: "new-session",
          updatedAt: 200,
        },
      ),
    ).toEqual({
      sessionId: "old-session",
      updatedAt: 100,
      thinkingLevel: "high",
    });
  });

  it("preserves session-scoped continuity fields when the session id is unchanged", () => {
    expect(
      clearSessionScopedFieldsOnSessionIdRollover(
        {
          sessionId: "same-session",
          updatedAt: 100,
          sessionFile: "/tmp/same-session.jsonl",
          cliSessionIds: { "github-copilot": "cli-same" },
          systemPromptReport: { warnings: ["keep"] },
          abortedLastRun: true,
        },
        {
          sessionId: "same-session",
          updatedAt: 200,
        },
      ),
    ).toEqual({
      sessionId: "same-session",
      updatedAt: 100,
      sessionFile: "/tmp/same-session.jsonl",
      cliSessionIds: { "github-copilot": "cli-same" },
      systemPromptReport: { warnings: ["keep"] },
      abortedLastRun: true,
    });
  });
});

describe("sessionFileHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false for undefined sessionFile", async () => {
    expect(await sessionFileHasContent(undefined)).toBe(false);
  });

  it("returns false when session file does not exist", async () => {
    expect(await sessionFileHasContent(path.join(tmpDir, "nonexistent.jsonl"))).toBe(false);
  });

  it("returns false when session file is empty", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(file, "", "utf-8");
    expect(await sessionFileHasContent(file)).toBe(false);
  });

  it("returns false when session file has only user message (no assistant flush)", async () => {
    const file = path.join(tmpDir, "user-only.jsonl");
    await fs.writeFile(
      file,
      '{"type":"session","id":"s1"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(false);
  });

  it("returns true when session file has assistant message (flushed)", async () => {
    const file = path.join(tmpDir, "with-assistant.jsonl");
    await fs.writeFile(
      file,
      '{"type":"session","id":"s1"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n{"type":"message","message":{"role":"assistant","content":"hi"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns true when session file has spaced JSON (role : assistant)", async () => {
    const file = path.join(tmpDir, "spaced.jsonl");
    await fs.writeFile(
      file,
      '{"type":"message","message":{"role": "assistant","content":"hi"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns true when assistant message appears after large user content", async () => {
    const file = path.join(tmpDir, "large-user.jsonl");
    // Create a user message whose JSON line exceeds 256KB to ensure the
    // JSONL-based parser (CWE-703 fix) finds the assistant record that a
    // naive byte-prefix approach would miss.
    const bigContent = "x".repeat(300 * 1024);
    const lines =
      [
        `{"type":"session","id":"s1"}`,
        `{"type":"message","message":{"role":"user","content":"${bigContent}"}}`,
        `{"type":"message","message":{"role":"assistant","content":"done"}}`,
      ].join("\n") + "\n";
    await fs.writeFile(file, lines, "utf-8");
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns false when session file is a symbolic link", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    await fs.writeFile(
      realFile,
      '{"type":"message","message":{"role":"assistant","content":"hi"}}\n',
      "utf-8",
    );
    const link = path.join(tmpDir, "link.jsonl");
    await fs.symlink(realFile, link);
    expect(await sessionFileHasContent(link)).toBe(false);
  });
});
