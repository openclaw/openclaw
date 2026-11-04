import http from "node:http";
import { streamSimpleOpenAICompletions } from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.sqlite-read.js";
import { SessionEntryChangedDuringReadError } from "../../../config/sessions/session-entry-read-errors.js";
import * as transcriptReaders from "../../../config/sessions/session-transcript-execution-read.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import * as historyReaders from "../../../config/sessions/session-transcript-worker-readers.js";
import { appendAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.runtime.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { MODEL_FALLBACK_NOTICE_KIND } from "../../../shared/model-fallback-notice.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import { FailoverError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  registerAgentSessionLoopTestLifecycle,
  testModel,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";
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
          expect(hydrationReads).toBe(change === "admitted-receipt" ? 1 : 2);
          expect(messagePresenceReads).toBe(0);
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

describe("fallback replay HTTP dispatch", () => {
  let listener: Awaited<ReturnType<typeof reserveTestPortListener<http.Server>>>;
  let requests: Array<{ model: string; messages: unknown[] }> = [];
  let primaryAbort: AbortController;
  let primaryMode: "timeout" | "notice";
  let baseUrl: string;
  beforeAll(async () => {
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            const parsed = JSON.parse(body) as { model: string; messages: unknown[] };
            requests.push(parsed);
            if (parsed.model === "primary") {
              if (primaryMode === "timeout") {
                // Event-driven timeout-owner injection: abort only after real HTTP dispatch.
                primaryAbort.abort(new Error("request timeout"));
                res.end();
              } else {
                res.writeHead(408, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "upstream request timed out" } }));
              }
              return;
            }
            const chunk = (delta: object, finish: string | null) =>
              `data: ${JSON.stringify({
                id: "fallback",
                object: "chat.completion.chunk",
                created: 1,
                model: "backup",
                choices: [{ index: 0, delta, finish_reason: finish }],
              })}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
              chunk({ role: "assistant", content: "BACKUP_DISPATCHED" }, null) +
                chunk({}, "stop") +
                "data: [DONE]\n\n",
            );
          });
        }),
    });
    baseUrl = `http://127.0.0.1:${listener.claim.port}/v1`;
  });
  afterAll(async () => {
    listener.listener.closeAllConnections();
    await listener.releaseListener();
    await listener.claim.release();
  });

  it.each(["timeout", "notice"] as const)(
    "dispatches backup HTTP after same-run %s",
    async (mode) => {
      requests = [];
      primaryMode = mode;
      primaryAbort = new AbortController();
      await withEnvAsync({ no_proxy: "127.0.0.1" }, () =>
        withInterruptedTurn(
          false,
          async (fixture) => {
            let selected = "primary";
            let primaryStopReason: string | undefined;
            streamMocks.streamSimple.mockImplementation((model, context, options) =>
              streamSimpleOpenAICompletions(
                { ...model, api: "openai-completions", id: selected, baseUrl },
                context,
                {
                  ...options,
                  apiKey: "synthetic-test-key",
                  ...(selected === "primary" ? { signal: primaryAbort.signal } : {}),
                },
              ),
            );
            const result = await runWithModelFallback({
              cfg: undefined,
              provider: "test-provider",
              model: "primary",
              manifestPlugins: [],
              fallbacksOverride: ["test-provider/backup"],
              run: async (_provider, model, options) => {
                selected = model;
                fixture.attempt.fallbackReason = options?.modelRoutingProvenance.fallbackReason;
                let last: ReturnType<typeof createAssistant> | undefined;
                await withReplaySession(fixture, false, async (session, submit) => {
                  await submit();
                  const message = session.messages.findLast((entry) => entry.role === "assistant");
                  if (message?.role === "assistant") {
                    last = message;
                  }
                });
                if (model === "primary") {
                  primaryStopReason = last?.stopReason;
                  throw new FailoverError("primary request timeout", { reason: "timeout" });
                }
                expect(fixture.attempt.fallbackReason).toBe("timeout");
                return last;
              },
              onFallbackStep: async (step) => {
                if (mode !== "notice" || step.fallbackStepFinalOutcome !== "next_fallback") {
                  return;
                }
                const notice = await appendAssistantMessageToSessionTranscript({
                  ...fixture.target,
                  expectedSessionId: fixture.target.sessionId,
                  idempotencyKey: "fallback-notice",
                  text: "Model switched to backup.",
                  deliveryMirror: {
                    kind: MODEL_FALLBACK_NOTICE_KIND,
                    runId: fixture.attempt.runId,
                    fromModel: "test-provider/primary",
                    toModel: "test-provider/backup",
                    reason: "timeout",
                  },
                });
                expect(notice.ok).toBe(true);
              },
            });
            expect(primaryStopReason).toBe(mode === "timeout" ? "aborted" : "error");
            expect(requests.map((request) => request.model)).toEqual(["primary", "backup"]);
            expect(
              JSON.stringify(requests[1]?.messages).match(/Finish this exact turn/g),
            ).toHaveLength(1);
            expect(JSON.stringify(result.result)).toContain("BACKUP_DISPATCHED");
            expect(
              loadTranscriptEventsSync(fixture.target).filter(
                (entry) =>
                  isRecord(entry) &&
                  entry.type === "message" &&
                  isRecord(entry.message) &&
                  entry.message.role === "user",
              ),
            ).toHaveLength(1);
          },
          { interruptedTurn: false },
        ),
      );
    },
  );

  it.each(["direct-abort", "historical-abort", "final", "format", "length"] as const)(
    "does not dispatch for %s",
    async (boundary) => {
      requests = [];
      await withInterruptedTurn(
        false,
        async (fixture) => {
          const manager = guardSessionManager(await SessionManager.openAsync(fixture.target), {
            runId: boundary === "historical-abort" ? "old-run" : fixture.attempt.runId,
          });
          await manager.appendMessageAsync(
            createAssistant(
              testModel,
              boundary === "final" ? "FINAL" : [],
              boundary === "final" ? "stop" : boundary === "length" ? "length" : "aborted",
            ),
          );
          fixture.attempt.fallbackReason =
            boundary === "direct-abort"
              ? undefined
              : boundary === "format" || boundary === "length"
                ? boundary
                : "timeout";
          await withReplaySession(fixture, false, async (_session, submit) => {
            const before = loadTranscriptEventsSync(fixture.target);
            await submit();
            expect(loadTranscriptEventsSync(fixture.target)).toEqual(before);
          });
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(requests).toEqual([]);
        },
        { interruptedTurn: false },
      );
    },
  );
});
