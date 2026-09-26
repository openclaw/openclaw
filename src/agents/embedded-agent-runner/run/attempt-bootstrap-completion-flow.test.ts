/**
 * Proves the continuation-skip bootstrap contract end to end: production attempt
 * preparation, production turn finalization writing the durable marker, and the next
 * production preparation reading that marker back.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { hasCompletedBootstrapTurn } from "../../bootstrap-files.js";
import { resetLegacyWorkspaceStateCheckForTest } from "../../workspace-legacy-state.test-support.js";

const hoisted = vi.hoisted(() => ({
  runAgentEndSideEffects: vi.fn(),
  shouldWaitForCompletionRequiredAsyncTasks: vi.fn((): boolean => false),
}));

vi.mock("../../harness/agent-end-side-effects.js", () => ({
  runAgentEndSideEffects: hoisted.runAgentEndSideEffects,
}));
vi.mock("./agent-end-context.js", () => ({
  buildEmbeddedAgentEndContext: () => ({}),
}));
vi.mock("./attempt-async-tasks.js", () => ({
  shouldWaitForCompletionRequiredAsyncTasks: hoisted.shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks: vi.fn(),
}));

import { SessionManager } from "../../sessions/session-manager.js";
import { DEFAULT_AGENTS_FILENAME } from "../../workspace.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("embedded attempt bootstrap completion flow", () => {
  let testState: Awaited<ReturnType<typeof createOpenClawTestState>>;

  beforeEach(async () => {
    resetLegacyWorkspaceStateCheckForTest();
    hoisted.runAgentEndSideEffects.mockReset();
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-bootstrap-completion-flow-",
    });
  });

  afterEach(async () => {
    await testState.cleanup();
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
  });

  it("records a marker through finalization and the next preparation skips injection", async () => {
    // A setup-complete workspace: the AGENTS.md content is real on-disk state and no
    // BOOTSTRAP.md is pending, which is the shape that the widened eligibility covers.
    const workspaceDir = tempDirs.make("openclaw-completion-flow-workspace-");
    await fs.writeFile(
      path.join(workspaceDir, DEFAULT_AGENTS_FILENAME),
      "# Workspace rules\nNever force push.\n",
      "utf8",
    );
    const dir = await fs.realpath(workspaceDir);
    const target = {
      agentId: "main",
      sessionId: "completion-flow",
      sessionKey: "agent:main:completion-flow",
      storePath: path.join(dir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage({
      role: "user",
      content: "what are the workspace rules?",
      timestamp: 1,
    });

    const config = {
      agents: { defaults: { contextInjection: "continuation-skip" } },
    } as unknown as OpenClawConfig;
    const attempt = {
      runId: "completion-flow",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      config,
      provider: "test",
      modelId: "model",
      trigger: "user",
      isCanonicalWorkspace: true,
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      bootstrapPromptWarningSignaturesSeen: [],
      bootstrapPromptWarningSignature: undefined,
    };
    const setup = {
      effectiveWorkspace: dir,
      resolvedWorkspace: dir,
      sessionAgentId: target.agentId,
      prepStages: { mark: () => {} },
    };
    const prepare = () =>
      prepareEmbeddedAttemptBootstrap({
        attempt: attempt as never,
        setup: setup as never,
        hasReadTool: true,
        isRawModelRun: false,
      });

    const firstTurn = await prepare();
    expect(
      firstTurn.contextFiles.some(
        (file) => typeof file.content === "string" && file.content.includes("Never force push."),
      ),
    ).toBe(true);
    expect(firstTurn.shouldRecordCompletedBootstrapTurn).toBe(true);
    expect(await hasCompletedBootstrapTurn(target)).toBe(false);

    // The real after-turn finalization, fed by the real preparation result.
    await completeEmbeddedAttemptAfterTurn(
      {
        attempt: attempt as never,
        activeContextEngine: undefined,
        agentDir: dir,
        resolveActiveContextEnginePluginId: () => undefined,
        setup,
        sessionLock: {
          withOwnedTranscriptWrite: async (operation: () => unknown) => await operation(),
        },
        state: { terminal: { kind: "ok" } },
        prepared: {
          bootstrap: firstTurn,
          bundleTools: { uncompactedEffectiveTools: [] },
          toolBase: { nestedToolActivities: undefined },
          sessionRuntime: {
            sessionManager,
            agentSession: { hookRunner: null },
            state: { prePromptMessageCount: 1 },
            contextGuards: { getAfterTurnCheckpoint: () => null },
            cacheTrace: null,
            anthropicPayloadLogger: null,
          },
        },
        diagnostics: {
          diagnosticTrace: {
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
          } as never,
        },
      } as never,
      {
        promptError: null,
        sessionIdUsed: target.sessionId,
        messagesSnapshot: [{ role: "assistant", content: "Never force push." }] as never,
        lastCallUsage: undefined,
        promptCache: undefined,
        compactionOccurredThisAttempt: false,
      } as never,
      { yieldAborted: false, transcriptLeafId: null, promptStartedAt: Date.now() },
    );

    // Only finalization can have written this: the test never appends the entry.
    expect(
      SessionManager.open(target, dir)
        .getEntries()
        .some((entry) => entry.type === "custom"),
    ).toBe(true);
    expect(await hasCompletedBootstrapTurn(target)).toBe(true);

    const secondTurn = await prepare();
    expect(secondTurn.contextFiles).toStrictEqual([]);
    expect(secondTurn.shouldRecordCompletedBootstrapTurn).toBe(false);
  });
});
