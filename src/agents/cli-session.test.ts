/**
 * Regression coverage for CLI session persistence helpers.
 * Verifies provider-keyed bindings, legacy cleanup, and reuse invalidation.
 */
import { describe, expect, it } from "vitest";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { forkCliSessionBindings } from "../config/sessions/cli-session-binding.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  isCliSessionInvalidatingFailoverReason,
  resolveCliSessionClearReason,
  resolveCliSessionReuse,
  setCliSessionBinding,
  shouldClearFailedCliSessionBinding,
} from "./cli-session.js";
import { FailoverError } from "./failover-error.js";

const ordinaryPolicyHash = "3ae4a9801e78dd74aa01b3ccad9fb6ab5628c39000b88276f651ed7fb9bdb555";
const explicitFalsePolicyHash = "92a8de91722cbb4fe1a7fd6892245e359c339d96cafe8db3a08738ffda913d71";

describe("cli-session helpers", () => {
  it("persists binding metadata without recreating the retired Claude field", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    const binding = {
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-hash",
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      mcpConfigHash: "mcp-hash",
      mcpResumeHash: "mcp-resume-hash",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    } satisfies CliSessionBinding;
    const expectedBinding = structuredClone(binding);
    setCliSessionBinding(entry, "claude-cli", binding);

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry).not.toHaveProperty("claudeCliSessionId");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual(expectedBinding);
  });

  it("preserves receipts only while updating the same native CLI session", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    const receipt = {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId: "openclaw-session",
      userTurnDisposition: "persisted" as const,
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: receipt,
    });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-1" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(receipt);

    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-2" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toBeUndefined();
  });

  it("force-reuses explicitly attached CLI sessions despite metadata drift", () => {
    const binding = {
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };
    const current = {
      binding,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        ...current,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        ...current,
        authEpoch: "auth-epoch-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        ...current,
        extraSystemPromptHash: "prompt-b",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        ...current,
        promptToolNamesHash: "prompt-tools-b",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["prompt-tools"] },
    });
    expect(
      resolveCliSessionReuse({
        ...current,
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("validates a forked binding against the child's account before resuming it", () => {
    const forked = forkCliSessionBindings(
      {
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "native-parent",
            resumeCheckpointId: "parent-checkpoint",
            forceReuse: true,
            authProfileId: "anthropic:work",
            authEpoch: "auth-epoch-a",
            authEpochVersion: 2,
          },
        },
      },
      () => true,
    );
    const binding = forked?.["claude-cli"];

    // The fork marker never bypasses the fingerprint checks.
    expect(binding).toEqual({
      sessionId: "native-parent",
      resumeCheckpointId: "parent-checkpoint",
      forkNextResume: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
    });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
      }),
    ).toMatchObject({ mode: "reuse", sessionId: "native-parent" });
  });

  it("invalidates reuse when message-tool prompt policy changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      messageToolPolicyHash: "message-policy-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        messageToolPolicyHash: "message-policy-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "message-policy" });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        messageToolPolicyHash: "message-policy-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it.each([
    ["tool-only delivery", "dd1ac522a78b476a0d590b59b030bc2782506da8411e21ab0a5c973320e0754d"],
  ])("does not normalize %s into the implicit ordinary policy", (_name, policyHash) => {
    for (const ordinaryHash of [undefined, ordinaryPolicyHash, explicitFalsePolicyHash]) {
      for (const [stored, current] of [
        [ordinaryHash, policyHash],
        [policyHash, ordinaryHash],
      ]) {
        expect(
          resolveCliSessionReuse({
            binding: { sessionId: "cli-session-1", messageToolPolicyHash: stored },
            authEpochVersion: 7,
            messageToolPolicyHash: current,
          }),
        ).toEqual({ mode: "invalidate", invalidatedReason: "message-policy" });
      }
    }
  });

  it("invalidates reuse when the task cwd changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      cwdHash: hashCliSessionText("/work/repo-a"),
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo-b"),
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "cwd" });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo-a"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("prefers the stable MCP resume hash over the raw MCP config hash", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-a",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });

  it("preserves reusable bindings for aborts and clears only invalid sessions", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });

    const binding = { sessionId: "reused" };
    const forkBinding = { sessionId: "fork-source", forkNextResume: true as const };

    expect(shouldClearFailedCliSessionBinding({ error: abort, binding })).toBe(false);
    expect(shouldClearFailedCliSessionBinding({ error: abort, binding: forkBinding })).toBe(false);
    expect(
      shouldClearFailedCliSessionBinding({
        error: abort,
        binding: { sessionId: "replacement" },
        bindingReplacedDuringRun: true,
      }),
    ).toBe(true);
    expect(
      shouldClearFailedCliSessionBinding({
        error: new FailoverError("session expired", {
          reason: "session_expired",
          provider: "claude-cli",
          model: "claude-opus-4-8",
        }),
        binding,
        hasNewGeneratedMediaTask: true,
      }),
    ).toBe(false);
    expect(resolveCliSessionClearReason(abort)).toBe("AbortError");
    expect(
      shouldClearFailedCliSessionBinding({ error: new Error("provider failed"), binding }),
    ).toBe(false);
    expect(shouldClearFailedCliSessionBinding({ error: abort })).toBe(false);
  });

  it.each(["session_expired"] as const)(
    "only clears binding for a provider-expired session: %s",
    (reason) => {
      const error = new FailoverError("failover", { reason, provider: "claude-cli" });
      const invalidatesSession = reason === "session_expired";

      expect(isCliSessionInvalidatingFailoverReason(reason)).toBe(invalidatesSession);
      expect(shouldClearFailedCliSessionBinding({ error, binding: { sessionId: "reused" } })).toBe(
        invalidatesSession,
      );
    },
  );
});
