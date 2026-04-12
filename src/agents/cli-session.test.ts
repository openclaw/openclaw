import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  resolveSuppressedCliHistoryImportProviders,
  resolveCliSessionReuse,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      suppressCliHistoryImport: true,
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
    expect(entry.suppressCliHistoryImport).toBeUndefined();
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(resolveCliSessionReuse({ binding: getCliSessionBinding(entry, "claude-cli") })).toEqual({
      sessionId: "legacy-session",
    });
  });

  it("invalidates legacy bindings when auth, prompt, or MCP state changes", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
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
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-b",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
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
      suppressCliHistoryImport: true,
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");
    expect(entry.suppressCliHistoryImport).toBeUndefined();

    entry.suppressCliHistoryImport = true;
    clearAllCliSessions(entry);
    expect(entry.suppressCliHistoryImport).toBeUndefined();
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("keeps reset CLI import suppression until a new binding is stored", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      suppressCliHistoryImport: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
        "codex-cli": "codex-session",
      },
      claudeCliSessionId: "claude-session",
    };

    clearCliSession(entry, "codex-cli");
    expect(entry.suppressCliHistoryImport).toBe(true);
    expect(entry.suppressCliHistoryImportProviders).toEqual(["claude-cli"]);
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    setCliSessionBinding(entry, "codex-cli", { sessionId: "replacement-codex-session" });
    expect(entry.suppressCliHistoryImport).toBe(true);
    expect(entry.suppressCliHistoryImportProviders).toEqual(["claude-cli"]);
  });

  it("keeps reset CLI import suppression when the preserved session is rebound unchanged", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      suppressCliHistoryImport: true,
      cliSessionBindings: {
        "codex-cli": { sessionId: "preserved-codex-session" },
      },
      cliSessionIds: {
        "codex-cli": "preserved-codex-session",
      },
    };

    setCliSessionBinding(entry, "codex-cli", { sessionId: "preserved-codex-session" });

    expect(entry.suppressCliHistoryImport).toBe(true);
    expect(getCliSessionBinding(entry, "codex-cli")?.sessionId).toBe("preserved-codex-session");
  });

  it("keeps reset suppression scoped to other preserved providers after a fresh rebind", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      suppressCliHistoryImport: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "preserved-claude-session" },
        "codex-cli": { sessionId: "preserved-codex-session" },
      },
      cliSessionIds: {
        "claude-cli": "preserved-claude-session",
        "codex-cli": "preserved-codex-session",
      },
      claudeCliSessionId: "preserved-claude-session",
    };

    setCliSessionBinding(entry, "codex-cli", { sessionId: "fresh-codex-session" });

    expect(entry.suppressCliHistoryImport).toBe(true);
    expect(resolveSuppressedCliHistoryImportProviders(entry)).toEqual(["claude-cli"]);
    expect(getCliSessionBinding(entry, "codex-cli")?.sessionId).toBe("fresh-codex-session");
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("preserved-claude-session");
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
