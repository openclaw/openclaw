import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.sqlite-read.js";
import { SessionEntryChangedDuringReadError } from "../../../config/sessions/session-entry-read-errors.js";
import * as transcriptReaders from "../../../config/sessions/session-transcript-execution-read.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import * as historyReaders from "../../../config/sessions/session-transcript-worker-readers.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db.js";
import {
  createAssistant,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { withInterruptedTurn } from "./attempt-session-replay.test-support.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";

registerAgentSessionLoopTestLifecycle();

describe("transcript replay cohorts", () => {
  it("retains bootstrap presence when the bounded active path has no messages", async () => {
    await withInterruptedTurn(
      false,
      async (fixture) => {
        await SessionManager.open(fixture.target).appendLeafControlAsync({
          targetId: null,
          appendParentId: null,
        });
        await waitForSessionTranscriptProjection(fixture.target);
        const bootstrap = vi.fn(async () => {});
        let owner: SessionManager | undefined;
        try {
          const prepared = await fixture.prepare(
            (manager) => {
              owner = manager;
            },
            {
              activeContextEngine: {
                info: { id: "raw-message-presence" },
                bootstrap,
              } as unknown as ContextEngine,
            },
          );
          expect(
            prepared.sessionManager.getBranch().some((entry) => entry.type === "message"),
          ).toBe(false);
          expect(bootstrap).toHaveBeenCalledOnce();
        } finally {
          await cleanupEmbeddedAttemptResources({
            sessionManager: owner,
            flushPendingToolResultsAfterIdle: async () => {},
          });
        }
      },
      { selectedOwner: true, admittedReceipt: true, interruptedTurn: false },
    );
  });

  it("decides initial replay before publishing the mutable manager", async () => {
    await withInterruptedTurn(
      false,
      async (fixture) => {
        const writer = SessionManager.open(fixture.target);
        await writer.appendMessageAsync(
          createAssistant(testModel, [{ type: "text", text: "Already completed" }]),
        );
        const before = loadTranscriptEventsSync(fixture.target);
        const prepared = await fixture.prepare((manager) => {
          const leaf = manager.getLeafEntry();
          if (leaf?.type !== "message") {
            throw new Error("Expected the completed message at publication");
          }
          Object.assign(leaf, { type: "custom", customType: "unpersisted-navigation" });
        });
        expect(prepared.prepareInitialUserTurnReplay).toBeUndefined();
        expect(loadTranscriptEventsSync(fixture.target)).toEqual(before);
      },
      { selectedOwner: true, admittedReceipt: true, interruptedTurn: false },
    );
  });

  it.each([
    "unchanged",
    "metadata-append",
    "local-navigation",
    "shared-store",
    "mutable-message",
    "wrong-hint",
    "admitted-receipt",
    "completed-after-preparation",
  ] as const)("consumes a fresh selected transcript after %s", async (change) => {
    await withInterruptedTurn(
      false,
      async (fixture) => {
        const reload = vi.spyOn(SessionManager.prototype, "reloadPersistedTranscriptAsync");
        let hydrationReads = 0;
        let messagePresenceReads = 0;
        const createReaders = historyReaders.createSessionHistoryWorkerReaders;
        const observeReads = vi
          .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
          .mockImplementation((runRequest) => {
            const readers = createReaders(runRequest);
            return {
              ...readers,
              readTranscript: async (input, signal) => {
                const transcript = await readers.readTranscript(input, signal);
                if (transcript.kind === "bounded") {
                  hydrationReads++;
                }
                return transcript;
              },
              readMessagePresence: async (input, signal) => {
                const present = await readers.readMessagePresence(input, signal);
                messagePresenceReads++;
                return present;
              },
            };
          });
        try {
          const prepared = await fixture.prepare();
          if (change === "admitted-receipt") {
            expect(hydrationReads).toBe(1);
            expect(messagePresenceReads).toBe(0);
          }
          expect(reload).not.toHaveBeenCalled();
          expect(fixture.attempt.userTurnTranscriptRecorder?.getAdmissionReceipt()).toMatchObject({
            agentId: fixture.target.agentId,
            storePath: fixture.target.storePath,
          });
          if (change === "metadata-append") {
            await SessionManager.open(fixture.target).appendThinkingLevelChange("high");
          } else if (change === "local-navigation") {
            await prepared.sessionManager.resetLeafAsync();
          } else if (change === "mutable-message" || change === "wrong-hint") {
            const leaf = prepared.sessionManager.getLeafEntry()!;
            if (
              change === "mutable-message" &&
              leaf.type === "message" &&
              leaf.message.role === "user"
            ) {
              leaf.message = { ...leaf.message, content: "Unpersisted replacement" };
            } else {
              Object.assign(leaf, { type: "custom", customType: "untrusted-hint" });
            }
          }
          const before = loadTranscriptEventsSync(fixture.target);
          const consume = await prepared.prepareInitialUserTurnReplay?.();
          expect(consume).toBeTypeOf("function");
          const admitted = vi.fn();
          if (change === "completed-after-preparation") {
            await SessionManager.open(fixture.target).appendMessageAsync(
              createAssistant(testModel, [{ type: "text", text: "Completed while preparing" }]),
            );
            await expect(consume!(admitted)).rejects.toThrow(/replay admission/);
            expect(admitted).not.toHaveBeenCalled();
            return;
          }
          await consume!(admitted);
          expect(admitted).toHaveBeenCalledOnce();
          if (change === "admitted-receipt") {
            await expect(consume!(admitted)).rejects.toThrow("already consumed");
            expect(admitted).toHaveBeenCalledOnce();
          }
          expect(reload).toHaveBeenCalledTimes(
            change === "wrong-hint" || change === "local-navigation" ? 1 : 0,
          );
          expect(
            prepared.sessionManager
              .getBranch()
              .some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "user" &&
                  entry.message.content === fixture.attempt.prompt,
              ),
          ).toBe(true);
          expect(loadTranscriptEventsSync(fixture.target)).toEqual(before);
        } finally {
          observeReads.mockRestore();
          reload.mockRestore();
        }
      },
      {
        selectedOwner: true,
        interruptedTurn: false,
        sharedStore: change === "shared-store",
        admittedReceipt: change === "admitted-receipt",
      },
    );
  });

  it.each([
    { phase: "legacy-final", change: "rewrite" },
    { phase: "legacy-final", change: "close" },
    { phase: "legacy-final", change: "revoke" },
    { phase: "selected-initial", change: "rewrite" },
    { phase: "selected-initial", change: "close" },
    { phase: "selected-initial", change: "revoke" },
    { phase: "selected-final", change: "rewrite" },
    { phase: "selected-final", change: "close" },
    { phase: "selected-final", change: "revoke" },
  ] as const)(
    "refuses $phase replay after $change between worker validation and consumption",
    async ({ phase, change }) => {
      await withInterruptedTurn(
        false,
        async (fixture) => {
          const prepared = phase !== "selected-initial" ? await fixture.prepare() : undefined;
          const admit = await prepared?.prepareInitialUserTurnReplay?.();
          if (prepared) {
            expect(admit).toBeTypeOf("function");
          }
          const original = SessionManager.open(fixture.target);
          const validated = createDeferredCore();
          const release = createDeferredCore();
          const createPreparedReads = transcriptReaders.createPreparedSessionTranscriptReads;
          const createHistoryReads = historyReaders.createSessionHistoryWorkerReaders;
          const spy =
            phase === "legacy-final"
              ? vi
                  .spyOn(transcriptReaders, "createPreparedSessionTranscriptReads")
                  .mockImplementation((params) => {
                    const readers = createPreparedReads(params);
                    return {
                      ...readers,
                      readAnchors: async (input, signal) => {
                        const facts = await readers.readAnchors(input, signal);
                        if (facts.replayValidated === "current") {
                          validated.resolve();
                          await release.promise;
                        }
                        return facts;
                      },
                    };
                  })
              : vi
                  .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
                  .mockImplementation((runRequest) => {
                    const readers = createHistoryReads(runRequest);
                    return {
                      ...readers,
                      readTranscript: async (input, signal) => {
                        const transcript = await readers.readTranscript(input, signal);
                        if (
                          transcript.kind === "bounded" &&
                          transcript.transcript?.replayValidated === "current"
                        ) {
                          validated.resolve();
                          await release.promise;
                        }
                        return transcript;
                      },
                    };
                  });
          const consume = vi.fn();
          const pending = phase === "selected-initial" ? fixture.prepare() : admit!(consume);
          let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
          try {
            await awaitGateBeforeSettlement(
              validated.promise,
              pending,
              "Replay validation was not reached",
            );
            if (change === "rewrite") {
              expect(original.removeTrailingEntries(() => true)).toBeGreaterThan(0);
            } else if (change === "close") {
              closing = closeOpenClawAgentDatabaseByPathAsync(fixture.target.storePath!);
            } else {
              fixture.revoke();
            }
            release.resolve();
            if (change === "rewrite" && phase !== "legacy-final") {
              await expect(pending).rejects.toBeInstanceOf(SessionEntryChangedDuringReadError);
            } else {
              await expect(pending).rejects.toThrow(/replay|revoked|closed|current|admission/i);
            }
            expect(consume).not.toHaveBeenCalled();
          } finally {
            release.resolve();
            await Promise.allSettled([pending, closing]);
            spy.mockRestore();
          }
        },
        {
          selectedOwner: phase !== "legacy-final",
          admittedReceipt: phase === "selected-initial",
        },
      );
    },
  );
});
