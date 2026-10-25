import { describe, expect, it } from "vitest";
import type {
  CliSessionBinding,
  CliSessionReseedReceipt,
  SessionEntry,
} from "../config/sessions.js";
import {
  forkCliSessionBindings,
  normalizeCliSessionReseedReceipt,
  rebindCliSessionReseedReceiptsForReset,
} from "../config/sessions/cli-session-binding.js";
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
const auth = {
  authProfileId: "anthropic:work",
  authEpoch: "auth-epoch-a",
  authEpochVersion: 2,
};
const fingerprint = {
  ...auth,
  extraSystemPromptHash: "prompt-a",
  mcpConfigHash: "mcp-config-a",
  mcpResumeHash: "mcp-resume-a",
};
function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "openclaw-session", updatedAt: 1, ...overrides };
}
function receipt(overrides: Partial<CliSessionReseedReceipt> = {}): CliSessionReseedReceipt {
  return {
    version: 1,
    promptHash: "a".repeat(64),
    localSessionId: "openclaw-session",
    userTurnDisposition: "persisted",
    ...overrides,
  };
}
function reuseBinding(binding: CliSessionBinding | undefined) {
  return (current: Partial<Omit<Parameters<typeof resolveCliSessionReuse>[0], "binding">> = {}) =>
    resolveCliSessionReuse({ binding, authEpochVersion: 2, ...current });
}
const reused = { mode: "reuse", sessionId: "cli-session-1" };
const drifted = { ...reused, mode: "reuse-with-drift", drift: { reasons: ["system-prompt"] } };
function invalidated(invalidatedReason: string) {
  return { mode: "invalidate", invalidatedReason };
}

describe("cli-session helpers", () => {
  it("persists binding metadata without recreating the retired Claude field", () => {
    const entry = makeEntry();

    const binding = {
      sessionId: "cli-session-1",
      forceReuse: true,
      ...fingerprint,
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      reseedReceipt: receipt(),
    } satisfies CliSessionBinding;
    const expectedBinding = structuredClone(binding);
    setCliSessionBinding(entry, "claude-cli", binding);

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry).not.toHaveProperty("claudeCliSessionId");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual(expectedBinding);
  });

  it("drops malformed reseed receipts while preserving the session binding", () => {
    const entry = makeEntry();

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: receipt({ promptHash: "not-a-digest" }),
    });

    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding?.sessionId).toBe("cli-session-1");
    expect(binding?.reseedReceipt).toBeUndefined();
  });

  it.each(["localSessionId", "userTurnDisposition"] as const)(
    "rejects reseed receipts without %s",
    (field) => {
      expect(
        normalizeCliSessionReseedReceipt({ ...receipt(), [field]: undefined }),
      ).toBeUndefined();
    },
  );

  it("rebinds only omitted receipts across binding-preserving resets", () => {
    const bindings = {
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: receipt({
          localSessionId: "old-local-session",
          userTurnDisposition: "omitted",
        }),
      },
      "other-cli": {
        sessionId: "other-session",
        reseedReceipt: receipt({ promptHash: "b".repeat(64), localSessionId: "old-local-session" }),
      },
    };

    expect(rebindCliSessionReseedReceiptsForReset(bindings, "new-local-session")).toEqual({
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: receipt({
          localSessionId: "new-local-session",
          userTurnDisposition: "omitted",
        }),
      },
      "other-cli": bindings["other-cli"],
    });
    expect(bindings["claude-cli"].reseedReceipt.localSessionId).toBe("old-local-session");
  });

  it("preserves receipts only while updating the same native CLI session", () => {
    const entry = makeEntry();
    const reseedReceipt = receipt();

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt,
    });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-1" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(reseedReceipt);

    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-2" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toBeUndefined();
  });

  it("force-reuses explicitly attached CLI sessions despite metadata drift", () => {
    expect(
      reuseBinding({ sessionId: "cli-session-1", forceReuse: true, ...fingerprint })({
        ...fingerprint,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual(reused);
  });

  it("leaves the Claude-only field to Doctor instead of selecting it for resume", () => {
    const entry = makeEntry({ claudeCliSessionId: "Legacy-Conversation" });

    expect(getCliSessionBinding(entry, " CLAUDE-CLI ")).toBeUndefined();
    expect(entry.claudeCliSessionId).toBe("Legacy-Conversation");
  });

  it("keeps provider-keyed bindings reusable until richer metadata is persisted", () => {
    const entry = makeEntry({
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    });

    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(entry, "claude-cli"),
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "legacy-session" });
  });

  it("invalidates legacy bindings on mechanical changes and resumes on content drift", () => {
    const entry = makeEntry({
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    });
    const reuse = reuseBinding(getCliSessionBinding(entry, "claude-cli"));
    expect(reuse({ authProfileId: "anthropic:work" })).toEqual(invalidated("auth-profile"));
    expect(reuse({ extraSystemPromptHash: "prompt-hash" })).toEqual({
      ...drifted,
      sessionId: "legacy-session",
    });
    expect(reuse({ mcpConfigHash: "mcp-hash" })).toEqual(invalidated("mcp"));
  });

  it.each(["prompt-a", "prompt-b"])(
    "invalidates tool catalog drift with a stable MCP topology and system prompt %s",
    (extraSystemPromptHash) => {
      const reuse = reuseBinding({
        sessionId: "cli-session-1",
        ...fingerprint,
        promptToolNamesHash: "tools-without-exec",
      });

      expect(
        reuse({ ...fingerprint, extraSystemPromptHash, promptToolNamesHash: "tools-with-exec" }),
      ).toEqual(invalidated("prompt-tools"));
    },
  );

  it("validates a forked binding against the child's account before resuming it", () => {
    const forked = forkCliSessionBindings(
      {
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "native-parent",
            resumeCheckpointId: "parent-checkpoint",
            transcriptCursor: { localSessionId: "parent", entryId: "input", runId: "run" },
            forceReuse: true,
            ...auth,
          },
        },
      },
      () => true,
    );
    const binding = forked?.["claude-cli"];
    const reuse = reuseBinding(binding);

    // The fork marker never bypasses the fingerprint checks.
    expect(binding).toEqual({
      sessionId: "native-parent",
      resumeCheckpointId: "parent-checkpoint",
      forkNextResume: true,
      ...auth,
    });
    expect(reuse({ authProfileId: "anthropic:personal", authEpoch: "auth-epoch-b" })).toEqual(
      invalidated("auth-profile"),
    );
    expect(reuse({ authProfileId: "anthropic:work", authEpoch: "auth-epoch-b" })).toEqual(
      invalidated("auth-epoch"),
    );
    expect(reuse({ authProfileId: "anthropic:work", authEpoch: "auth-epoch-a" })).toMatchObject({
      mode: "reuse",
      sessionId: "native-parent",
    });
  });

  it("keeps content-drift bindings reusable for queued turns until hashes refresh", () => {
    const binding = { sessionId: "cli-session-1", ...fingerprint };
    const current = { ...fingerprint, extraSystemPromptHash: "prompt-b" };
    const reuse = reuseBinding(binding);
    expect(reuse(current)).toEqual(drifted);
    expect(reuse(current)).toEqual(drifted);
    binding.extraSystemPromptHash = "prompt-b";
    expect(reuse(current)).toEqual(reused);
  });

  it("invalidates reuse when message-tool prompt policy changes", () => {
    const reuse = reuseBinding({
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      messageToolPolicyHash: "message-policy-a",
    });

    expect(reuse({ messageToolPolicyHash: "message-policy-b" })).toEqual(
      invalidated("message-policy"),
    );
    expect(reuse({ messageToolPolicyHash: "message-policy-a" })).toEqual(reused);
  });

  it.each([
    ["tool-only delivery", "dd1ac522a78b476a0d590b59b030bc2782506da8411e21ab0a5c973320e0754d"],
    [
      "explicit message targets",
      "d454cef8c2f11b7bda35560680cb87dc78286ac7d9c3ba02f5ab832a5db65cda",
    ],
    ["unknown policy", "unknown-policy-fingerprint"],
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
        ).toEqual(invalidated("message-policy"));
      }
    }
  });

  it.each([
    {
      reason: "auth-profile",
      current: { authProfileId: "other-profile", authEpoch: "other-epoch" },
    },
    { reason: "auth-epoch", current: { authEpoch: "other-epoch" } },
    { reason: "cwd", current: { cwdHash: "other-workspace" } },
    { reason: "mcp", current: { mcpConfigHash: "other-mcp-topology" } },
  ])("keeps the $reason boundary strict when upgrading implicit policy", ({ reason, current }) => {
    const compatible = {
      authProfileId: "profile-a",
      authEpoch: "epoch-a",
      authEpochVersion: 7,
      cwdHash: "workspace-a",
      mcpConfigHash: "mcp-topology-a",
    };
    for (const storedPolicy of [undefined, ordinaryPolicyHash, explicitFalsePolicyHash]) {
      expect(
        resolveCliSessionReuse({
          ...compatible,
          binding: {
            ...compatible,
            sessionId: "cli-session-1",
            messageToolPolicyHash: storedPolicy,
          },
          messageToolPolicyHash: ordinaryPolicyHash,
          ...current,
        }),
      ).toEqual({ mode: "invalidate", invalidatedReason: reason });
    }
  });

  it("invalidates reuse when the task cwd changes", () => {
    const reuse = reuseBinding({
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      cwdHash: hashCliSessionText("/work/repo-a"),
    });

    expect(reuse({ cwdHash: hashCliSessionText("/work/repo-b") })).toEqual(invalidated("cwd"));
    expect(reuse({ cwdHash: hashCliSessionText("/work/repo-a") })).toEqual(reused);
  });

  it("reuses when auth profile ids rotate but the versioned auth epoch is stable", () => {
    expect(
      reuseBinding({ sessionId: "cli-session-1", ...fingerprint })({
        ...fingerprint,
        authProfileId: "anthropic:work-alias",
      }),
    ).toEqual(reused);
  });

  it.each([
    [undefined, "previous-auth-epoch", 2, "anthropic:work"],
    [2, "refresh-token-auth-epoch", 3, "anthropic:work"],
    [3, undefined, 4, undefined],
  ] as const)(
    "accepts stored auth epoch (%s, %s) on upgrade to v%s",
    (storedVersion, storedEpoch, currentVersion, profile) => {
      // The last row is a pre-v4 Gemini binding without an identity fingerprint.
      expect(
        reuseBinding({
          ...fingerprint,
          sessionId: "cli-session-1",
          authProfileId: profile,
          authEpoch: storedEpoch,
          authEpochVersion: storedVersion,
        })({
          ...fingerprint,
          authProfileId: profile,
          authEpoch: "identity-auth-epoch",
          authEpochVersion: currentVersion,
        }),
      ).toEqual(reused);
    },
  );

  it("prefers the stable MCP resume hash over the raw MCP config hash", () => {
    const reuse = reuseBinding({ sessionId: "cli-session-1", ...fingerprint });

    expect(reuse({ ...fingerprint, mcpConfigHash: "mcp-config-b" })).toEqual(reused);
    expect(reuse({ ...fingerprint, mcpResumeHash: "mcp-resume-b" })).toEqual(invalidated("mcp"));
  });

  it("falls back to legacy MCP config hashes when stored resume hashes are absent", () => {
    const reuse = reuseBinding({
      ...fingerprint,
      sessionId: "cli-session-1",
      mcpResumeHash: undefined,
    });
    expect(reuse(fingerprint)).toEqual(reused);
    expect(reuse({ ...fingerprint, mcpConfigHash: "mcp-config-b" })).toEqual(invalidated("mcp"));
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry = makeEntry();
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

  it.each(["format", "auth", "session_expired"] as const)(
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
