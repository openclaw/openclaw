// Extracted sibling of prepare.test.ts (kept separate to respect the per-file line
// cap). Covers the fresh-session reseed boundary end to end — the authority-chain proof
// that the revised owner admits covered same-account context while rejecting foreign,
// uncovered, and snapshotless history before final CLI input: a genuinely session-less
// turn under stable auth reseeds prior transcript context like a missing transcript,
// while an account transition (a transcript owned by a different credential) and a
// missing/mismatched boundary snapshot over uncovered content both stay refused.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI fresh session-less reseed boundary", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  // Establishes an owned CLI history writer under a stable credential without touching
  // the transcript. A later session-less prepare then sees a boundary owned by the same
  // account, so declining to hand back a writer reads as "fresh", not an account change.
  async function establishOwnedAuth(otherAccount = false) {
    const { dir, sessionTarget } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    const credential = { type: "token" as const, provider: "test-cli", token: "stable-account" };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: credential,
          "history-test:other": { type: "token", provider: "test-cli", token: "other-account" },
        },
      },
      agentDir,
    );
    const runId = "fresh-reseed-fixture";
    await patchSessionEntryCore(sessionTarget, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "fresh-reseed-fixture");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    const { writer } = await prepareCliHistoryBoundary(
      {
        admittedRunContext,
        runId,
        agentDir,
        provider: "test-cli",
        model: "test-model",
        prompt: "seed",
        workspaceDir: dir,
        timeoutMs: 1000,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
      },
      { credential },
    );
    expect(writer).toBeDefined();
    return (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
      fixture.prepare({
        agentDir,
        authProfileId: otherAccount ? "history-test:other" : authProfileId,
        runId,
        admittedRunContext,
        sessionKey: sessionTarget.sessionKey,
        ...overrides,
      });
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        buildDefaultTestCliBackend({ reseedFromRawTranscriptWhenUncompacted: true }),
      ],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      fixture.cleanup();
    }
  });

  it("reseeds prior context for a fresh session-less turn under stable auth", async () => {
    const prepare = await establishOwnedAuth();
    // Advance the transcript without the owned writer: this is exactly the fresh
    // session-less shape — no reusable CLI session and no established history writer,
    // under the same stable credential that owns the transcript. It must reseed.
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior session-less ask", 1),
    });

    const context = await prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeDefined();
    expect(context.openClawHistoryPrompt).toContain("prior session-less ask");
    expect(context.openClawHistoryPrompt).toContain("latest ask");
  });

  it("refuses reseed across an account boundary even when a transcript exists", async () => {
    const prepare = await establishOwnedAuth(true);
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior account-owned ask", 1),
    });

    const context = await prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });

  it("refuses reseed when the boundary snapshot is missing but uncovered content remains", async () => {
    const prepare = await establishOwnedAuth();
    const { sessionTarget } = fixture.session;
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior uncovered ask", 1),
    });
    // Drop the boundary entry to a mismatched session id while the transcript content
    // survives — an entry pruned/reset or a projection race. This is exactly the early
    // return where `loadSessionEntryReadOnly` yields no matching snapshot AFTER the
    // same-session checks passed. Ownership was never verified, so the content must NOT
    // be replayed; master refused it, and reseeding it would leak uncovered history.
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const context = await prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });

  it("classifies a snapshotless but proven-empty transcript as a fresh start", async () => {
    const { dir, sessionTarget } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const credential = { type: "token" as const, provider: "test-cli", token: "stable-account" };
    const runId = "snapshotless-empty";
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "snapshotless-empty");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    // Mismatched boundary snapshot, but no transcript content beyond the session header:
    // there is nothing to leak, so the missing-snapshot early return must still classify
    // this genuinely session-less turn as "fresh" (reseedable) rather than over-refusing.
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const result = await prepareCliHistoryBoundary(
      {
        admittedRunContext,
        runId,
        agentDir,
        provider: "test-cli",
        model: "test-model",
        prompt: "hi",
        workspaceDir: dir,
        timeoutMs: 1000,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
      },
      { credential },
    );

    expect(result.writer).toBeUndefined();
    expect(result.declined).toBe("fresh");
  });

  it("refuses reseed for a revoked/absent credential over uncovered content with no boundary", async () => {
    // No auth profile is saved and none is passed, so prepare resolves NO credential — the
    // revoked/absent-owner case. The session entry exists and matches (created by the
    // fixture) but carries no cliHistoryBoundary, and transcript content is present. This is
    // the later `!stored` exit: ownership cannot be proven from an absent fingerprint and
    // there is no boundary to match against, so a session-less turn over uncovered content
    // must stay refused — master's behavior — not reseed on `!cliSessionId` alone.
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior unowned ask", 1),
    });

    const context = await fixture.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });
});
