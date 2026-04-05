import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  resolveCliSessionReuse,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside provider session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "codex-cli", {
      sessionId: "cli-session-1",
      authProfileId: "openai-codex:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(entry.cliSessionIds?.["codex-cli"]).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "codex-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "openai-codex:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "codex-cli": "legacy-session" },
    };

    expect(resolveCliSessionReuse({ binding: getCliSessionBinding(entry, "codex-cli") })).toEqual({
      sessionId: "legacy-session",
    });
  });

  it("invalidates legacy bindings when auth, prompt, or MCP state changes", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "codex-cli": "legacy-session" },
    };
    const binding = getCliSessionBinding(entry, "codex-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "openai-codex:work",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "openai-codex:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "openai-codex:personal",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "openai-codex:work",
        authEpoch: "auth-epoch-b",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "openai-codex:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "openai-codex:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("does not treat model changes as a session mismatch", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ sessionId: "cli-session-1" });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(entry.cliSessionIds?.["codex-cli"]).toBeUndefined();

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
