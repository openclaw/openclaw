/**
 * Whether a cleared CLI binding that recorded no auth identity may still replay
 * its prior transcript into a fresh CLI session.
 *
 * Lives beside `session-history.test.ts` because it asserts the whole chain —
 * reuse resolution, prepare's reason default, the raw-reseed allowlist — rather
 * than one loader behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  clearCliSession,
  cliSessionClearAuthFromRun,
  getCliSessionBinding,
  resolveCliSessionReuse,
  setCliSessionId,
} from "../cli-session.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildCliSessionHistoryPrompt, loadCliSessionReseedMessages } from "./session-history.js";

/** Canonical session-store target for a transcript under `rootDir`. */
function sessionTargetIn(rootDir: string, sessionId: string): SessionTranscriptRuntimeTarget {
  return {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:main",
    storePath: path.join(rootDir, "agents", "main", "sessions", "sessions.json"),
  };
}

async function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  messages: string[];
}): Promise<SessionTranscriptRuntimeTarget> {
  // Written through the canonical session store the loader actually reads, so
  // the reseed path exercises the shape persisted OpenClaw sessions have.
  const target = sessionTargetIn(params.rootDir, params.sessionId);
  await upsertSessionEntryCore(target, { sessionId: params.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(target, params.rootDir);
  for (const [index, message] of params.messages.entries()) {
    manager.appendMessage({ role: "user", content: message, timestamp: index + 1 });
  }
  manager.flushPendingPersistence();
  return target;
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

/** `prepare.ts`'s reason for a turn with no reusable CLI session id. */
function reseedReasonForNextTurn(
  entry: SessionEntry,
  current: { authProfileId?: string; authEpoch?: string; authEpochVersion: number },
) {
  const reuse = resolveCliSessionReuse({
    binding: getCliSessionBinding(entry, "claude-cli"),
    ...current,
  });
  expect(reuse.mode).not.toBe("reuse");
  const invalidatedReason = reuse.mode === "invalidate" ? reuse.invalidatedReason : undefined;
  return invalidatedReason ?? "missing-transcript";
}

describe("raw reseed across a cleared binding that recorded no auth identity", () => {
  // End-to-end shape of the P1: a bare binding (the `setCliSessionId` fallback,
  // and the legacy rows it stands in for) is cleared, and the next turn decides
  // whether the prior transcript may replay into the fresh CLI session. The
  // decision runs through the real chain — reuse resolution, prepare's reason
  // default, then the reseed allowlist — rather than asserting any one step.
  const CURRENT_IDENTITY = {
    authProfileId: "anthropic:current",
    authEpoch: "epoch-current",
    authEpochVersion: 1,
  } as const;

  async function reseedAfterClear(current: {
    authProfileId?: string;
    authEpoch?: string;
    authEpochVersion: number;
  }): Promise<unknown[]> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionTarget = await createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-cleared-bare-binding",
      messages: ["prior-auth secret"],
    });
    const entry = { sessionId: "session-cleared-bare-binding" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");
    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(CURRENT_IDENTITY));

    try {
      return await withCliSessionState(stateDir, async () =>
        loadCliSessionReseedMessages({
          sessionTarget,
          // The claude-cli backend opts in (`reseedFromRawTranscriptWhenUncompacted`).
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: reseedReasonForNextTurn(entry, current),
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it("replays the prior transcript when the next turn carries the same auth identity", async () => {
    const reseed = await reseedAfterClear(CURRENT_IDENTITY);
    expect(reseed.length).toBeGreaterThan(0);
    expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
      "prior-auth secret",
    );
  });

  it("refuses the replay when the next turn carries a different auth identity", async () => {
    const reseed = await reseedAfterClear({
      authProfileId: "anthropic:rotated",
      authEpoch: "epoch-rotated",
      authEpochVersion: 1,
    });
    expect(reseed).toStrictEqual([]);
  });
});

describe("compacted transcripts across an auth boundary", () => {
  // The compacted branch used to return the compaction summary plus the
  // verbatim post-compaction tail without consulting the reseed reason at all,
  // so an auth crossing that the raw path refused still replayed prior-auth
  // content by that route. A summary is transcript-derived too — it is written
  // *from* the turns the previous identity ran — so the boundary refuses both.
  const PRIOR_IDENTITY = {
    authProfileId: "anthropic:prior",
    authEpoch: "epoch-prior",
    authEpochVersion: 1,
  } as const;
  const SESSION_ID = "session-compacted-auth-boundary";

  async function createCompactedTranscript(
    rootDir: string,
  ): Promise<SessionTranscriptRuntimeTarget> {
    const target = sessionTargetIn(rootDir, SESSION_ID);
    await upsertSessionEntryCore(target, { sessionId: SESSION_ID, updatedAt: 1 });
    const manager = SessionManager.open(target, rootDir);
    const kept = manager.appendMessage({
      role: "user",
      content: "prior-auth secret",
      timestamp: 1,
    });
    manager.appendCompaction("Summary derived from the prior-auth conversation", kept, 1000);
    manager.appendMessage({
      role: "user",
      content: "post-compaction tail secret",
      timestamp: 3,
    });
    manager.flushPendingPersistence();
    return target;
  }

  /** Reseed the compacted transcript for a turn whose identity is `current`. */
  async function reseedCompactedAfterClear(current: {
    authProfileId?: string;
    authEpoch?: string;
    authEpochVersion: number;
  }): Promise<{ reason: string; messages: unknown[] }> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionTarget = await createCompactedTranscript(stateDir);
    const entry = { sessionId: SESSION_ID } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare", PRIOR_IDENTITY);
    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(PRIOR_IDENTITY));
    const reason = reseedReasonForNextTurn(entry, current);

    try {
      return {
        reason,
        messages: await withCliSessionState(stateDir, async () =>
          loadCliSessionReseedMessages({
            sessionTarget,
            allowRawTranscriptReseed: true,
            rawTranscriptReseedReason: reason,
          }),
        ),
      };
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it("reseeds the summary and the post-compaction tail when no auth boundary is crossed", async () => {
    // The control: without this the refusal tests below could pass vacuously,
    // for want of any compacted content to refuse in the first place.
    const { reason, messages } = await reseedCompactedAfterClear(PRIOR_IDENTITY);
    expect(reason).toBe("missing-transcript");
    const prompt = buildCliSessionHistoryPrompt({ messages, prompt: "next" });
    expect(prompt).toContain("Summary derived from the prior-auth conversation");
    expect(prompt).toContain("post-compaction tail secret");
  });

  it("returns no compacted content when the auth profile changed", async () => {
    const { reason, messages } = await reseedCompactedAfterClear({
      authProfileId: "anthropic:rotated",
      authEpoch: "epoch-rotated",
      authEpochVersion: 1,
    });
    expect(reason).toBe("auth-profile");
    expect(messages).toStrictEqual([]);
  });

  it("returns no compacted content when the auth epoch changed", async () => {
    const { reason, messages } = await reseedCompactedAfterClear({
      // Same profile, rotated credential under the same epoch version: the
      // crossing reuse resolution reports as `auth-epoch` rather than `auth-profile`.
      authProfileId: PRIOR_IDENTITY.authProfileId,
      authEpoch: "epoch-rotated",
      authEpochVersion: PRIOR_IDENTITY.authEpochVersion,
    });
    expect(reason).toBe("auth-epoch");
    expect(messages).toStrictEqual([]);
  });
});
