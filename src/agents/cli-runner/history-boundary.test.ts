import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  getCliHistoryWriter,
  runWithCliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { CliSessionBinding } from "../../config/sessions/types.js";
import { commitCronConversationResult } from "../../cron/conversation-result.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { buildPersistedVoiceMessage } from "../../talk/voice-transcript.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { persistCliSessionBindingResult } from "../cli-session-store.js";
import { getCliSessionBinding } from "../cli-session.js";
import { claimAgentSessionWriter } from "../embedded-agent-runner/run/session-bootstrap.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { buildCliSessionBinding } from "./cli-run-settlement.js";
import {
  persistApprovedCliUserTurnTranscript,
  persistCliAssistantTranscript,
} from "./cli-run-transcript.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "./execute.test-support.js";
import {
  prepareCliHistoryBoundary,
  prepareCliHistoryCompactionBoundary,
} from "./history-boundary.js";
import { createHistoryBoundaryFixture, history } from "./history-boundary.test-support.js";
import { loadCliSessionPromptContext } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "cli-history-boundary-",
);
afterEach(() => {
  vi.restoreAllMocks();
});

const fixture = (withHeader?: boolean) => createHistoryBoundaryFixture(sessionDirs, withHeader);
type Fixture = Awaited<ReturnType<typeof fixture>>;
type RunParams = PreparedCliRunContext["params"];
const identity = { credential: { type: "token" as const, provider: "test-cli", token: "epoch-a" } };
const append = (f: Fixture, content: string, timestamp = 2) =>
  f.manager().appendMessage({ role: "user", content, timestamp });
const persistAnswer = (params: RunParams, text: string) =>
  persistCliAssistantTranscript({
    runParams: { ...params, persistAssistantTranscript: true },
    text,
    modelId: "test-model",
    stopReason: "stop",
  });
const withCredential = (
  f: Fixture,
  credential: Parameters<Fixture["run"]>[3],
  action: Parameters<Fixture["run"]>[1],
) => f.run(undefined, action, {}, credential);
const seededFixture = async () => {
  const f = await fixture();
  await f.seed();
  return f;
};
const afterPlanning = (action: () => void | Promise<void>, once = false) => {
  const patch = patchSessionEntryCore;
  const replacement: typeof patch = (target, update, options) =>
    patch(
      target,
      async (...args) => {
        const planned = await update(...args);
        const effect = action();
        if (effect) {
          await effect;
        }
        return planned;
      },
      options,
    );
  const spy = vi.spyOn(sessionAccessor, "patchSessionEntryCore");
  return once ? spy.mockImplementationOnce(replacement) : spy.mockImplementation(replacement);
};

async function settleNativeBinding(
  params: PreparedCliRunContext["params"],
  assertSettlementCurrent: () => void,
  binding?: CliSessionBinding,
) {
  return await persistCliSessionBindingResult({
    agentId: "main",
    provider: params.provider,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    expectedSession: params.sessionEntry,
    assertSettlementCurrent,
    result: {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "native-recovered",
          provider: params.provider,
          model: "test-model",
          cliSessionBinding: binding ?? {
            sessionId: "native-recovered",
            authProfileId: "test-cli:saved",
          },
        },
      },
    },
  });
}

describe("CLI transcript account boundary", () => {
  it.each(["claude-cli", "google-gemini-cli"] as const)(
    "hands cron and Talk results to the next native-only %s resume once without granting recovery",
    async (provider) => {
      const f = await fixture();
      const config = { session: { store: f.target.storePath } };
      const prompts: string[] = [];
      const markers = ["CRON_RESULT", "VOICE_CORRECTION", "VOICE_DRAFT_B"] as const;
      for (const turn of [0, 1, 2]) {
        if (turn === 1) {
          await appendTranscriptMessage(f.target, {
            message: buildPersistedVoiceMessage({
              role: "user",
              text: markers[1],
              timestamp: 2,
              provider: "realtime",
            }),
          });
          const manager = f.manager();
          const consult: PersistedUserTurnMessage = {
            role: "user",
            content: "PRIVATE_CONSULT_PROMPT",
            timestamp: 3,
            display: false,
            excludeFromContext: true,
          };
          await manager.appendMessageAsync(consult);
          await manager.appendMessageAsync(
            makeAssistantMessageFixture({
              provider: "anthropic",
              stopReason: "stop",
              errorMessage: undefined,
              content: [{ type: "text", text: markers[2] }],
              timestamp: 4,
            }),
          );
        }
        const binding = getCliSessionBinding(loadSessionEntryReadOnly(f.target), provider);
        await f.run(
          undefined,
          async (allowed, params) => {
            expect(allowed).toBe(false);
            params.persistAssistantTranscript = true;
            params.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
              input: { text: params.prompt, idempotencyKey: `${params.runId}:user` },
              target: { ...f.target, sessionEntry: undefined, config },
            });
            const before = JSON.stringify(await loadTranscriptEvents(f.target));
            const notes = await loadCliSessionPromptContext({
              ...params,
              nativeSessionId: binding?.sessionId,
              cliSessionBinding: binding,
              rawTranscriptReseedReason: "auth-unknown",
              allowRawTranscriptReseed: true,
            });
            expect(JSON.stringify(await loadTranscriptEvents(f.target))).toBe(before);
            expect(notes.reseedMessages).toEqual([]);
            expect(notes.durableContext).toBeUndefined();
            if (turn === 1) {
              const fresh = await loadCliSessionPromptContext({
                ...params,
                nativeSessionId: undefined,
                rawTranscriptReseedReason: "auth-unknown",
                allowRawTranscriptReseed: true,
              });
              expect(fresh.resumeContext).toBeUndefined();
              expect(fresh.reseedMessages).toEqual([]);
              expect(fresh.durableContext).toBeUndefined();
            }
            const context = buildPreparedCliRunContext({
              provider,
              sessionTarget: f.target,
              workspaceDir: params.workspaceDir,
              backend: {
                command: "/bin/sh",
                args: [],
                resumeArgs: ["--resume", "{sessionId}"],
                output: "json",
                sessionIdFields: ["session_id"],
                input: "stdin",
                systemPromptFileArg: undefined,
              },
            });
            context.params = params;
            context.resumeContext = notes.resumeContext;
            context.transcriptCursor = notes.transcriptCursor;
            context.reusableCliSession = binding
              ? { mode: "reuse", sessionId: binding.sessionId }
              : { mode: "none" };
            await persistApprovedCliUserTurnTranscript(params);
            supervisorSpawnMock.mockImplementationOnce(async (spawn) => {
              if (spawn.mode !== "child") {
                throw new Error("Expected CLI child process");
              }
              prompts.push(spawn.input ?? "");
              // A completion arriving during the CLI turn precedes its assistant row,
              // but was absent from that turn's input snapshot.
              if (turn === 0) {
                await expect(
                  commitCronConversationResult({
                    config,
                    agentId: f.target.agentId,
                    jobId: "catch-up",
                    runStartedAt: 1,
                    conversation: {
                      ...f.target,
                      lifecycleRevision: loadSessionEntryReadOnly(f.target)?.lifecycleRevision,
                    },
                    payloads: [{ text: markers[0] }],
                    deliveryAttemptFence: null,
                  }),
                ).resolves.toMatchObject({ ok: true });
                const steered = createUserTurnTranscriptRecorder({
                  input: { text: "ACCEPTED_STEER", idempotencyKey: "accepted-steer:user" },
                  target: { ...f.target, sessionEntry: undefined, config },
                });
                await steered.persistApproved();
                await steered.confirmSteerTargetRunIdForPersistence?.(params.runId);
              }
              const sessionFlag = spawn.argv.includes("--resume") ? "--resume" : "--session-id";
              return createManagedRun({
                ...createSuccessfulProcessExit(),
                stdout: JSON.stringify({
                  result: `CLI_REPLY_${turn}`,
                  session_id: spawn.argv.includes(sessionFlag)
                    ? spawn.argv[spawn.argv.indexOf(sessionFlag) + 1]
                    : "native-session",
                }),
              });
            });
            const output = await executePreparedCliRun(context, binding?.sessionId);
            expect(output.sessionId).toBeTruthy();
            const persisted = await persistCliAssistantTranscript({
              runParams: params,
              text: output.text,
              modelId: context.modelId,
              stopReason: "stop",
            });
            expect(persisted.owned).toBe(true);
            await appendTranscriptMessage(f.target, {
              message: makeAssistantMessageFixture({
                provider: "openclaw",
                model: "delivery-mirror",
                content: [{ type: "text", text: `CLI_REPLY_${turn}` }],
              }),
            });
            await settleNativeBinding(
              { ...params, sessionEntry: loadSessionEntryReadOnly(f.target) },
              () => {},
              buildCliSessionBinding(context, output.sessionId!, output),
            );
          },
          {
            provider,
            config,
            nativeAuthOnly: true,
            cliSessionBinding: binding,
            prompt: `TYPED_REQUEST_${turn}`,
          },
        );
      }
      for (const marker of markers) {
        expect(prompts[0]).not.toContain(marker);
        expect.soft(prompts[1]?.split(marker)).toHaveLength(2);
        expect(prompts[2]).not.toContain(marker);
      }
      expect(prompts[1]).not.toContain("PRIVATE_CONSULT_PROMPT");
      expect(prompts[1]).not.toContain("CLI_REPLY_0");
      expect(prompts[1]).not.toContain("ACCEPTED_STEER");
      expect(prompts[2]).not.toContain("TYPED_REQUEST_1");
    },
  );

  it("prepares and commits CLI history without caller-thread data SQL", async () => {
    const f = await seededFixture();
    await f.withRun("worker-preparation", async (params) => {
      const sql = observeHostDataSql();
      try {
        const writer = await prepareCliHistoryBoundary(params, identity);
        expect(writer).toBeDefined();
        expect(sql.queries, `MAIN SQL observations: ${sql.queries.length}`).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  });

  it.each(["append", "rewrite", "reset", "revocation"] as const)(
    "refuses an intervening %s before committing the planned history boundary",
    async (change) => {
      const f = await seededFixture();
      const abort = new AbortController();
      afterPlanning(() => {
        if (change === "revocation") {
          abort.abort();
        } else if (change === "reset") {
          f.manager().appendResetBoundary("reset");
        } else {
          append(f, "intervening");
          if (change === "rewrite") {
            f.manager().removeTrailingEntries((entry) => entry.type === "message");
          }
        }
      });
      await f.withRun(
        "changed-preparation",
        async (params) => {
          await expect(prepareCliHistoryBoundary(params, identity)).rejects.toThrow();
          expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).not.toBe(params.runId);
        },
        { abortSignal: abort.signal },
      );
    },
  );

  it.each(["append", "rewrite"] as const)(
    "plans again after one late %s instead of failing the turn",
    async (change) => {
      const f = await seededFixture();
      afterPlanning(() => {
        if (change === "append") {
          append(f, "late settle");
        } else {
          f.manager().removeTrailingEntries((entry) => entry.type === "message");
        }
      }, true);
      await f.withRun("replanned-preparation", async (params) => {
        const writer = await prepareCliHistoryBoundary(params, identity);
        expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
        // The fresh plan judges the settled transcript: an unproven foreign row stays
        // unknown, while an emptied context may start a new boundary.
        expect(Boolean(writer)).toBe(change === "rewrite");
      });
    },
  );

  it.each([false, true])(
    "keeps compacted history only when the complete source is account-owned (foreign tail: %s)",
    async (foreignTail) => {
      const f = await seededFixture();
      const retained = await f.run("epoch-a", async () => append(f, "Retained recent turn", 2));
      const manager = f.manager();
      if (foreignTail) {
        manager.appendMessage({ role: "user", content: "Unowned tail", timestamp: 3 });
      }
      if (!retained) {
        throw new Error("Missing retained turn");
      }
      const commit = await prepareCliHistoryCompactionBoundary(f.target, () => {});
      await manager.appendThinkingLevelChange("off");
      await manager.appendCustomEntryAsync("model-snapshot", { provider: "summary-fixture" });
      await manager.appendCompactionAsync("Compacted account summary", retained, 1000);
      await commit?.();
      await f.run("epoch-a", async (allowed, params) => {
        const prompt = await history(allowed, params);
        if (foreignTail) {
          expect(prompt).toBeUndefined();
        } else {
          expect(prompt?.match(/Compacted account summary/g)).toHaveLength(1);
          expect(prompt?.match(/Retained recent turn/g)).toHaveLength(1);
          expect(prompt).not.toContain("A private canary");
        }
      });
    },
  );

  it("distinguishes OAuth account identity from rotating or identity-less tokens", async () => {
    const f = await fixture();
    const credential = {
      type: "oauth" as const,
      provider: "test-cli",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 60_000,
    };
    await withCredential(f, credential, async (allowed) => expect(allowed).toBe(false));
    await withCredential(f, { ...credential, accountId: "account-a" }, async (allowed) => {
      expect(allowed).toBe(true);
      append(f, "named account", 1);
    });
    await withCredential(
      f,
      { ...credential, accountId: "account-a", access: "rotated-access" },
      async (allowed, params) => {
        expect(await history(allowed, params)).toContain("named account");
      },
    );
    await withCredential(f, { ...credential, accountId: "account-b" }, async (allowed) =>
      expect(allowed).toBe(false),
    );
  });

  it("compares resolved static tokens rather than the unchanged SecretRef", async () => {
    const f = await fixture();
    const tokenRef = { source: "env" as const, provider: "default", id: "TEST_TOKEN" };
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        append(f, "prior token", 1);
      },
      {},
      { type: "token", provider: "test-cli", token: "resolved-a", tokenRef },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { type: "token", provider: "test-cli", token: "resolved-b", tokenRef },
    );
  });

  it("revokes retained read and coverage capabilities when their admitted run closes", async () => {
    const f = await fixture();
    const writer = await f.run("epoch-a", async () => getCliHistoryWriter(f.target));
    if (!writer) {
      throw new Error("Missing admitted history writer");
    }
    const before = f.manager().getEntries();
    await expect(writer.assertReadable()).rejects.toThrow();
    expect(() => runWithCliHistoryWriter(writer, () => append(f, "late write", 1))).toThrow();
    expect(f.manager().getEntries()).toEqual(before);
  });

  it("detaches background persistence without lending it the closed CLI history proof", async () => {
    const f = await fixture();
    const release = createDeferred();
    const { background } = await f.run("epoch-a", async () => ({
      background: runWithoutOwnedSessionTranscriptWrites(async () => {
        await release.promise;
        append(f, "detached result", 1);
      }),
    }));
    release.resolve();
    await expect(background).resolves.toBeUndefined();
    expect(JSON.stringify(f.manager().getEntries())).toContain("detached result");
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("cannot launder mixed history by returning to the original account", async () => {
    const f = await seededFixture();
    await f.run("epoch-b", async (allowed, params) => {
      expect(await history(allowed, params)).toBeUndefined();
      append(f, "B private canary", 2);
    });
    for (const epoch of ["epoch-a", "epoch-b"]) {
      await f.run(epoch, async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    }
  });

  it.each(["unrecorded append", "rewrite", "missing provenance", "old version"])(
    "refuses legacy, import, and downgrade gaps: %s",
    async (change) => {
      const f = await seededFixture();
      if (change === "unrecorded append") {
        // Models run by an older binary cannot advance the new coverage proof.
        append(f, "unverified account", 2);
      } else if (change === "rewrite") {
        const manager = f.manager();
        manager.appendResetBoundary("reset", manager.getLeafId() ?? undefined);
      } else if (change === "missing provenance") {
        await patchSessionEntryCore(f.target, (entry) => ({
          ...entry,
          cliHistoryBoundary: undefined,
        }));
      } else {
        // A predecessor wrote serialized metadata outside the current typed writer contract.
        const database = new DatabaseSync(f.target.storePath);
        try {
          expect(
            database
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.cliHistoryBoundary.version', 0) WHERE session_key = ?",
              )
              .run(f.target.sessionKey).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
      }
      await f.run("epoch-a", async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    },
  );

  it("never treats an authless runtime or borrowed native session as a new trusted history", async () => {
    const f = await fixture();
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false));
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false), {
      cliSessionBinding: { sessionId: "external", forceReuse: true },
    });
  });

  it("only an empty reset can establish a fresh account boundary", async () => {
    const f = await seededFixture();
    await f.run("epoch-b", async (allowed) => expect(allowed).toBe(false));
    f.manager().appendResetBoundary("reset");
    await f.run("epoch-b", async (allowed) => {
      expect(allowed).toBe(true);
      append(f, "B fresh canary", 2);
    });
    await f.run("epoch-b", async (allowed, params) => {
      const prompt = await history(allowed, params);
      expect(prompt).toContain("B fresh canary");
      expect(prompt).not.toContain("A private canary");
    });
  });

  it("admits a finished writer's successor while refusing the live writer", async () => {
    const f = await seededFixture();
    await f.withRun("orchestrator-prior", async (params) => {
      await claimAgentSessionWriter(params);
      await f.withRun("direct-cli-blocked", async (direct) => {
        direct.sessionEntry = loadSessionEntryReadOnly(f.target);
        const before = structuredClone(direct.sessionEntry);
        const run = vi.fn(async (provider: string) =>
          provider === "fixture-next"
            ? "replayed"
            : (await prepareCliHistoryBoundary(direct, identity), "prepared"),
        );
        // The refusal is local session ownership; replaying on another model cannot repair it.
        const refusal = runWithModelFallback({
          cfg: undefined,
          provider: "test-cli",
          model: "fixture-model",
          manifestPlugins: [],
          fallbacksOverride: ["fixture-next/fixture-model"],
          run,
        });
        await expect(refusal).rejects.toMatchObject({ name: "CliHistoryOwnerChangedError" });
        await expect(refusal).rejects.toThrow("CLI history owner changed before preparation");
        expect(run).toHaveBeenCalledOnce();
        expect(direct.sessionEntry).toEqual(before);
      });
    });
    await f.withRun("direct-cli-recovery", async (params) => {
      params.sessionEntry = loadSessionEntryReadOnly(f.target);
      const expectedSession = params.sessionEntry;
      const writer = await prepareCliHistoryBoundary(params, identity);
      expect(writer).toBeDefined();
      if (!writer) {
        throw new Error("Missing admitted history writer");
      }
      expect(params.sessionEntry).toBe(expectedSession);
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
      await runWithCliHistoryWriter(writer, async () => {
        expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: f.target })).toEqual({
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: params.runId,
        });
        expect(
          getOwnedSessionTranscriptWriterFence({
            sessionTarget: { sessionKey: f.target.sessionKey },
          }),
        ).toBeUndefined();
        expect(await history(true, params)).toContain("A private canary");
        const result = await persistAnswer(params, "recovered CLI answer");
        expect(result.terminalAnchor).toBeDefined();
      });
      const settled = await settleNativeBinding(params, writer.assertCurrent);
      expect(settled.meta.error).toBeUndefined();
      expect(loadSessionEntryReadOnly(f.target)?.cliSessionBindings?.["test-cli"]).toEqual({
        sessionId: "native-recovered",
        authProfileId: "test-cli:saved",
      });
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("recovered CLI answer");
  });

  it("rejects CLI assistant persistence after its terminal writer claim is revoked", async () => {
    const f = await fixture();
    await f.withRun("terminal-cli-writer", async (params) => {
      const claim = await claimAgentSessionWriter(params);
      if (!claim) {
        throw new Error("Missing terminal CLI writer claim");
      }
      const before = f.manager().getEntries();

      await expect(claim.revoke()).resolves.toBe(true);
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...params,
          expectedLifecycleRevision: claim.expectedLifecycleRevision,
          expectedWriterRunId: claim.expectedWriterRunId,
          persistAssistantTranscript: true,
        },
        text: "late terminal CLI answer",
        modelId: "test-model",
        stopReason: "stop",
      });

      expect(result).toMatchObject({ owned: true });
      expect(result.terminalAnchor).toBeUndefined();
      expect(f.manager().getEntries()).toEqual(before);
    });
  });

  it("rechecks a revived foreign writer after metadata planning yields", async () => {
    const f = await seededFixture();
    await f.withRun("orchestrator-prior", async (params) => {
      await claimAgentSessionWriter(params);
    });
    const before = loadSessionEntryReadOnly(f.target);
    const replacement = prepareSystemAgentRunAdmission(
      {},
      "orchestrator-prior",
      "main",
      "history-test",
    );
    afterPlanning(async () => {
      await replacement.admit("embedded");
    });
    try {
      await f.withRun("direct-cli-recovery", async (params) => {
        await expect(prepareCliHistoryBoundary(params, identity)).rejects.toThrow(
          "CLI history owner changed before preparation",
        );
      });
      expect(loadSessionEntryReadOnly(f.target)).toEqual(before);
    } finally {
      replacement.close();
    }
  });

  it.each(["orchestrator-prior", "orchestrator-replacement", "direct-cli-recovery"])(
    "fences recovered history and CLI persistence after %s takes over",
    async (replacementRunId) => {
      const f = await seededFixture();
      await f.withRun("orchestrator-prior", async (params) => {
        await claimAgentSessionWriter(params);
      });
      await f.withRun("direct-cli-recovery", async (params) => {
        params.sessionEntry = loadSessionEntryReadOnly(f.target);
        const writer = await prepareCliHistoryBoundary(params, identity);
        expect(writer).toBeDefined();
        if (!writer) {
          throw new Error("Missing admitted history writer");
        }
        await writer.assertReadable();
        await f.withRun(replacementRunId, async (replacement) => {
          await claimAgentSessionWriter(replacement);
          await expect
            .soft(writer.assertReadable())
            .rejects.toThrow(
              replacementRunId === params.runId
                ? "admitted run authority is no longer active"
                : "CLI history authority changed",
            );
          const before = f.manager().getEntries();
          await runWithCliHistoryWriter(writer, async () => {
            const result = await persistAnswer(params, "late recovered CLI answer");
            expect.soft(result.terminalAnchor).toBeUndefined();
          });
          expect(f.manager().getEntries()).toEqual(before);
          const beforeBindingSettlement = loadSessionEntryReadOnly(f.target);
          await settleNativeBinding(params, writer.assertCurrent);
          expect(loadSessionEntryReadOnly(f.target)).toEqual(beforeBindingSettlement);
        });
      });
    },
  );
});
