import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadExactSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { claimAgentSessionWriter } from "./embedded-agent-runner/run/session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./embedded-agent-runner/run/session-prompt-state.js";
import { prepareTerminalWithSettledTurnFinalization } from "./embedded-agent-runner/run/settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./embedded-agent-runner/run/settled-turn-finalization.test-support.js";
import { EmptySettledTurnFinalizationError } from "./harness/settled-turn-finalization-outcome.js";
import {
  createInternalSessionEffectsCleanup,
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
} from "./internal-session-effects.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

function emptyFinalizationHarness() {
  const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "" }] });
  return {
    id: "internal-session-finalization-test",
    label: "Internal session finalization test",
    supports: () => ({ supported: true as const }),
    runAttempt: async () => {
      throw new Error("runAttempt is not used by this finalization fixture");
    },
    finalizeSettledTurn: async () => {
      throw new EmptySettledTurnFinalizationError({
        assistant,
        usage: assistant.usage,
      });
    },
  };
}

function createSettledToolUseAttempt(target: { sessionId: string; sessionFile: string }) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
  });
  const messagesSnapshot = [
    assistant,
    {
      role: "toolResult",
      toolCallId: "call-write",
      toolName: "write",
      isError: false,
      content: [{ type: "text", text: "Note saved" }],
      timestamp: 1,
    },
  ] as never;
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: { kind: "ok" },
    sessionIdUsed: target.sessionId,
    sessionFileUsed: target.sessionFile,
    assistantTexts: [],
    messagesSnapshot,
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    toolMetas: [{ toolCallId: "call-write", toolName: "write", isError: false, replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: Object.freeze([...messagesSnapshot]),
    },
  });
  return { ...attempt, successfulNestedToolNames: ["write"] };
}

async function createInternalFallbackFixture(input: {
  dir: string;
  runId: string;
  replacementWriterRunId?: string;
}) {
  const storePath = path.join(input.dir, "sessions.json");
  const target = await prepareInternalSessionEffectsSession({
    agentId: "main",
    cwd: input.dir,
    runId: input.runId,
    storePath,
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    input.runId,
    "main",
    "settled-finalization-internal-session-test",
  );
  const admittedRunContext = await admission.admit("embedded");
  const writer = await claimAgentSessionWriter({
    admittedRunContext,
    config: {},
    runId: input.runId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
  } as never);
  if (!writer) {
    throw new Error("internal session writer was not claimed");
  }
  const writerFence = {
    expectedLifecycleRevision: writer.expectedLifecycleRevision,
    expectedWriterRunId: writer.expectedWriterRunId,
  };
  if (input.replacementWriterRunId) {
    const replaced = await applySessionEntryOperation(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      },
      {
        kind: "fields",
        expected: {
          sessionId: target.sessionId,
          lifecycleRevision: writer.expectedLifecycleRevision,
        },
        patch: { activeWriterRunId: input.replacementWriterRunId },
      },
      { skipMaintenance: true },
    );
    expect(replaced?.activeWriterRunId).toBe(input.replacementWriterRunId);
  }
  const attempt = createSettledToolUseAttempt(target);
  const request = createSettledFinalizationTestInput(attempt, admittedRunContext);
  // This fixture exercises transcript custody, not bundled provider policy loading.
  // Keep terminal metadata on a synthetic provider so the test remains hermetic.
  request.terminalBase.provider = "test-provider";
  request.terminalBase.model = "test-model";
  request.terminalBase.activeErrorContext = { provider: "test-provider", model: "test-model" };
  request.initial.sessionIdUsed = target.sessionId;
  request.initial.sessionFileUsed = target.sessionFile;
  request.terminalBase.runParams = {
    ...request.terminalBase.runParams,
    agentId: target.agentId,
    config: {},
    runId: input.runId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sourceReplyDeliveryMode: "automatic",
    terminalReplyExpectation: "required",
    trigger: "user",
  } as never;
  request.finalization.preparedAttempt = {
    ...request.finalization.preparedAttempt,
    admittedRunContext,
    agentId: target.agentId,
    config: {},
    runId: input.runId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    workspaceDir: input.dir,
  } as never;
  request.finalization.sessionTarget = target;
  request.finalization.sessionWriterFence = writerFence;
  request.finalization.harness = emptyFinalizationHarness() as never;
  return { admission, request, target, writerFence };
}

describe("internal session effects", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-internal-session-effects-");
  it("keeps hidden effects from an incognito run in the sentinel store", async () => {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    try {
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "incognito-run",
        storePath,
      });

      expect(target.sessionKey).toMatch(
        /^agent:main:internal-session-effects:incognito-incognito-run-/,
      );
      expect(loadExactSessionEntry(target)?.entry.incognito).toBe(true);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("does not archive an incognito internal-effects transcript during rotation", async () => {
    const dir = tempDirs.make();
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      try {
        const target = await prepareInternalSessionEffectsSession({
          agentId: "main",
          runId: "rotation",
          storePath,
        });
        const previousTranscript = path.join(dir, "private-internal.jsonl");
        await fs.writeFile(
          previousTranscript,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: target.sessionId,
            timestamp: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        const previousEntry = await upsertSessionEntryCore(target, {
          ...target.sessionEntry,
          sessionFile: previousTranscript,
        });
        if (!previousEntry) {
          throw new Error("failed to seed incognito internal-effects entry");
        }
        const nextTranscript = path.join(dir, "next-internal.jsonl");

        await applySessionEntryLifecycleMutation({
          agentId: "main",
          activeSessionKey: target.sessionKey,
          storePath,
          upserts: [
            {
              sessionKey: target.sessionKey,
              entry: {
                ...previousEntry,
                sessionFile: nextTranscript,
                sessionId: "internal-session-effects-rotated",
                updatedAt: Date.now(),
              },
              resetBoundary: { context: "preserve-tail", reason: "reset", cwd: dir },
            },
          ],
          skipMaintenance: true,
        });

        expect(await fs.readdir(dir)).toContain("private-internal.jsonl");
        expect((await fs.readdir(dir)).some((name) => name.includes(".reset."))).toBe(false);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("creates a hidden deterministic SQLite session", async () => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      cwd: dir,
      runId: "run/with space",
      storePath,
    });

    expect(target.sessionKey).toMatch(/^agent:main:internal-session-effects:run_with_space-/);
    expect(target.sessionId).toMatch(/^internal-session-effects-run_with_space-/);
    expect(loadExactSessionEntry(target)?.entry).toMatchObject({
      sessionId: target.sessionId,
      createdVia: "internal",
      createdActor: { type: "system" },
      delivery: { kind: "internal" },
      createdAt: expect.any(Number),
    });
    expect(listSessionEntriesCore({ agentId: "main", storePath })).toEqual([]);
    await expect(loadTranscriptEvents(target)).resolves.toEqual([
      expect.objectContaining({ id: target.sessionId, type: "session" }),
    ]);

    const reopened = await prepareInternalSessionEffectsSession({
      agentId: "main",
      cwd: dir,
      runId: "run/with space",
      storePath,
    });
    expect(reopened).toEqual(target);
  });

  it("escapes the reserved prefix for a durable internal-effects run id", async () => {
    const dir = tempDirs.make();
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "incognito-not-private",
      storePath: path.join(dir, "sessions.json"),
    });

    expect(target.sessionKey).toMatch(
      /^agent:main:internal-session-effects:legacy-incognito-not-private-/,
    );
  });

  it.each(["copy", "reopen"] as const)("requires the current owner during %s", async (phase) => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const source = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "required-source",
      storePath,
    });
    await appendTranscriptMessage(source, {
      message: { role: "assistant", content: "retained progress", timestamp: 1 },
    });
    const request = {
      agentId: "main",
      runId: "required-successor",
      source,
      storePath,
    };
    if (phase === "reopen") {
      await prepareInternalSessionEffectsSession(request);
    }
    let current = phase === "copy";
    await expect(
      prepareInternalSessionEffectsSession({
        ...request,
        commitGuard: () => {
          if (!current) {
            throw new Error("recovery owner retired");
          }
          queueMicrotask(() => {
            current = false;
          });
        },
      }),
    ).rejects.toThrow("recovery owner retired");
    expect(JSON.stringify(await loadTranscriptEvents(source))).toContain("retained progress");
  });

  it.each([true, false])(
    "cleans only the latest tracked hidden identities when enabled=%s",
    async (enabled) => {
      const dir = tempDirs.make();
      const storePath = path.join(dir, "sessions.json");
      const errors: unknown[] = [];
      const cleanup = createInternalSessionEffectsCleanup({
        enabled,
        agentId: "main",
        runId: "tracked-run",
        storePath,
        onError: (error) => errors.push(error),
      });
      const initial = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "tracked-run",
        storePath,
      });
      const rotated = {
        agentId: initial.agentId,
        sessionId: "rotated-hidden-session",
        sessionKey: initial.sessionKey,
        storePath,
      };
      await upsertSessionEntryCore(rotated, { sessionId: rotated.sessionId, updatedAt: 2 });
      const additional = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "additional-binding",
        storePath,
      });
      const untracked = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "other-run",
        storePath,
      });
      const untrackedBefore = structuredClone(loadExactSessionEntry(untracked));
      expect(untrackedBefore).toBeDefined();
      for (const target of [rotated, additional]) {
        await appendTranscriptMessage(target, {
          message: { role: "assistant", content: "private", timestamp: 3 },
        });
        cleanup.track(target);
      }

      await cleanup.cleanup();

      expect(errors).toEqual([]);
      expect(loadExactSessionEntry(untracked)).toEqual(untrackedBefore);
      for (const target of [rotated, additional]) {
        if (enabled) {
          expect(loadExactSessionEntry(target)).toBeUndefined();
          await expect(loadTranscriptEvents(target)).resolves.toEqual([]);
        } else {
          expect(loadExactSessionEntry(target)?.entry.sessionId).toBe(target.sessionId);
          await expect(loadTranscriptEvents(target)).resolves.toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ role: "assistant", content: "private" }),
            }),
          );
        }
      }
    },
  );

  it("persists settled-turn fallback into a claimed internal-effects session and cleanup removes it", async () => {
    const dir = tempDirs.make();
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const runId = "skill-workshop-review:internal-fallback-success";
      const errors: unknown[] = [];
      const cleanup = createInternalSessionEffectsCleanup({
        enabled: true,
        agentId: "main",
        runId,
        storePath: path.join(dir, "sessions.json"),
        onError: (error) => errors.push(error),
      });
      const fixture = await createInternalFallbackFixture({ dir, runId });
      cleanup.track(fixture.target);
      fixture.request.finalization.sessionWriterFence = undefined;
      const state = await createEmbeddedRunSessionPromptState({
        runParams: {
          admittedRunContext: fixture.request.finalization.preparedAttempt.admittedRunContext,
          config: {},
          runId,
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          sessionFile: fixture.target.sessionFile,
          sessionTarget: { ...fixture.target, ...fixture.writerFence },
          workspaceDir: dir,
          prompt: "finish the internal review",
          timeoutMs: 60_000,
        },
        sessionAgentId: fixture.target.agentId,
        resolvedSessionKey: fixture.target.sessionKey,
        lifecycleGeneration: "test-generation",
        onInterrupt: () => {},
      });
      try {
        const result = await state.withSessionWriterContext(() =>
          prepareTerminalWithSettledTurnFinalization(fixture.request),
        );

        expect(result.attempt.assistantTranscriptOwned).toBe(true);
        expect(result.attempt.assistantTranscriptIdempotencyKey).toBe(
          `${runId}:settled-finalization-fallback`,
        );
        await expect(loadTranscriptEvents(fixture.target)).resolves.toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              idempotencyKey: `${runId}:settled-finalization-fallback`,
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining("The tool run finished"),
                }),
              ]),
            }),
            type: "message",
          }),
        );
        await cleanup.cleanup();
        expect(errors).toEqual([]);
        expect(loadExactSessionEntry(fixture.target)).toBeUndefined();
        await expect(loadTranscriptEvents(fixture.target)).resolves.toEqual([]);
      } finally {
        await state[Symbol.asyncDispose]();
        fixture.admission.close();
      }
    });
  });

  it("rejects settled-turn fallback after a genuine internal-effects writer replacement", async () => {
    const dir = tempDirs.make();
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const fixture = await createInternalFallbackFixture({
        dir,
        runId: "skill-workshop-review:internal-fallback-replaced",
        replacementWriterRunId: "replacement-review-run",
      });
      fixture.request.finalization.sessionWriterFence = undefined;
      const state = await createEmbeddedRunSessionPromptState({
        runParams: {
          admittedRunContext: fixture.request.finalization.preparedAttempt.admittedRunContext,
          config: {},
          runId: "skill-workshop-review:internal-fallback-replaced",
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          sessionFile: fixture.target.sessionFile,
          sessionTarget: { ...fixture.target, ...fixture.writerFence },
          workspaceDir: dir,
          prompt: "finish the internal review",
          timeoutMs: 60_000,
        },
        sessionAgentId: fixture.target.agentId,
        resolvedSessionKey: fixture.target.sessionKey,
        lifecycleGeneration: "test-generation",
        onInterrupt: () => {},
      });
      try {
        await expect(
          state.withSessionWriterContext(() =>
            prepareTerminalWithSettledTurnFinalization(fixture.request),
          ),
        ).rejects.toThrow(SessionTranscriptWriterClaimReboundError);
      } finally {
        await state[Symbol.asyncDispose]();
        fixture.admission.close();
      }
    });
  });

  it("hard-deletes the hidden entry and transcript rows", async () => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "run-cleanup",
      storePath,
    });
    await appendTranscriptMessage(target, {
      message: { content: "private", role: "assistant", timestamp: 2 },
    });

    await removeInternalSessionEffectsSession(target);

    expect(loadExactSessionEntry(target)).toBeUndefined();
    await expect(loadTranscriptEvents(target)).resolves.toEqual([]);
  });
});
