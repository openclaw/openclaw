// Proves saved history reaches a fresh CLI session unless a different account already ran it.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { appendTranscriptEventSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";
import { admitCliHistoryAccount } from "./history-boundary.js";
import { loadCliSessionPromptContext } from "./session-history.js";

const sessionDirs = useAutoCleanupTempDirTracker(afterEach);

async function createSession(sessionId = "history") {
  setRuntimeConfigSnapshot({});
  const dir = sessionDirs.make("openclaw-cli-history-");
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  appendTranscriptEventSync(target, {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    cwd: dir,
    timestamp: new Date(0).toISOString(),
  });
  let runs = 0;
  /** One CLI turn: admit its account, then read the history its prompt would carry. */
  const turn = async (credential?: AuthProfileCredential, sessionTarget = target) => {
    const runId = `cli-run-${++runs}`;
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-test");
    try {
      const params = {
        ...sessionTarget,
        admittedRunContext: await admission.admit("embedded"),
        runId,
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
        provider: "claude-cli",
        model: "test-model",
        prompt: "current ask",
        workspaceDir: dir,
        timeoutMs: 1000,
      };
      const admitted = await admitCliHistoryAccount(params, { credential });
      const { reseedMessages } = await loadCliSessionPromptContext({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: admitted?.replaysHistory ? "missing-transcript" : "auth-unknown",
      });
      return JSON.stringify(reseedMessages);
    } finally {
      admission.close();
    }
  };
  const say = (content: string) =>
    SessionManager.open(target, dir).appendMessage({ role: "user", content, timestamp: 1 });
  return { target, dir, turn, say };
}

const key = (value: string): AuthProfileCredential => ({
  type: "api_key",
  provider: "anthropic",
  key: value,
});

describe("CLI history account", () => {
  it("replays history another runtime wrote into the first Claude turn", async () => {
    const session = await createSession();
    session.say("GOAL_TOKEN aurora-7 from Gemini");
    expect(await session.turn(key("account-a"))).toContain("GOAL_TOKEN aurora-7");
    // An unidentified login before any account is recorded is ordinary session history too.
    const unidentified = await createSession("unidentified");
    unidentified.say("native login canary");
    expect(await unidentified.turn()).toContain("native login canary");
    expect(await unidentified.turn(key("account-a"))).toContain("native login canary");
  });

  it("keeps one account's history from another account, even after switching back", async () => {
    const session = await createSession();
    expect(await session.turn(key("account-a"))).toBe("[]");
    session.say("A private canary");
    expect(await session.turn(key("account-a"))).toContain("A private canary");
    expect(await session.turn(key("account-b"))).not.toContain("A private canary");
    session.say("B private canary");
    // Returning to A cannot launder B's turn into A's prompt.
    expect(await session.turn(key("account-a"))).not.toContain("canary");
    expect(await session.turn()).not.toContain("canary");
  });

  it("refuses an unidentified login once an account is recorded", async () => {
    const session = await createSession();
    session.say("A private canary");
    expect(await session.turn(key("account-a"))).toContain("A private canary");
    expect(await session.turn()).not.toContain("A private canary");
  });

  it("starts a new session id with no recorded account", async () => {
    const session = await createSession();
    session.say("A private canary");
    await session.turn(key("account-a"));
    await session.turn(key("account-b"));
    const next = { ...session.target, sessionId: "after-new" };
    await upsertSessionEntryCore(next, { sessionId: next.sessionId, updatedAt: 2 });
    appendTranscriptEventSync(next, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: next.sessionId,
      cwd: session.dir,
      timestamp: new Date(0).toISOString(),
    });
    SessionManager.open(next, session.dir).appendMessage({
      role: "user",
      content: "fresh canary",
      timestamp: 2,
    });
    expect(await session.turn(key("account-b"), next)).toContain("fresh canary");
  });

  it("keeps refusing a legacy record that could hide an account switch", async () => {
    const session = await createSession();
    session.say("A private canary");
    await upsertSessionEntryCore(session.target, {
      sessionId: session.target.sessionId,
      updatedAt: 3,
      cliHistoryBoundary: { version: 1, sessionId: session.target.sessionId, state: "unknown" },
    });
    expect(await session.turn(key("account-c"))).not.toContain("A private canary");
  });

  it("distinguishes named OAuth accounts from identity-less rotating tokens", async () => {
    const oauth = (accountId?: string, access = "access-1"): AuthProfileCredential => ({
      type: "oauth",
      provider: "anthropic",
      access,
      refresh: "refresh",
      expires: Date.now() + 60_000,
      ...(accountId ? { accountId } : {}),
    });
    const session = await createSession();
    session.say("A private canary");
    expect(await session.turn(oauth("account-a"))).toContain("A private canary");
    // A rotated access token for the same named account keeps its history.
    expect(await session.turn(oauth("account-a", "access-2"))).toContain("A private canary");
    expect(await session.turn(oauth())).not.toContain("A private canary");
  });
});
