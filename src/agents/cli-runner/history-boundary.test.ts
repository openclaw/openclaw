import path from "node:path";
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
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { persistCliSessionBindingResult } from "../cli-session-store.js";
import { claimAgentSessionWriter } from "../embedded-agent-runner/run/session-bootstrap.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";
import {
  CliHistoryOwnerChangedError,
  prepareCliHistoryBoundary,
  prepareCliHistoryCompactionBoundary,
} from "./history-boundary.js";
import { createHistoryBoundaryFixture, history } from "./history-boundary.test-support.js";
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

afterEach(() => {
  vi.useRealTimers();
});

function useOwnerSettleFakeTimers() {
  // Only the settle wait is virtual; SQLite workers and setImmediate stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** Advances the settle wait until `pending` settles, yielding real turns to session I/O. */
async function driveOwnerSettleTimers(pending: Promise<unknown>, until = () => false) {
  const state = { settled: false };
  void pending.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  for (let elapsed = 0; !state.settled && !until() && elapsed <= 20_000; elapsed += 50) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await vi.advanceTimersByTimeAsync(50);
  }
}

const fixture = (withHeader?: boolean) => createHistoryBoundaryFixture(sessionDirs, withHeader);

async function settleNativeBinding(
  params: PreparedCliRunContext["params"],
  assertSettlementCurrent: () => void,
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
          cliSessionBinding: {
            sessionId: "native-recovered",
            authProfileId: "test-cli:saved",
          },
        },
      },
    },
  });
}

describe("CLI transcript account boundary", () => {
  it("prepares and commits CLI history without caller-thread data SQL", async () => {
    const f = await fixture();
    await f.seed();
    await f.withRun("worker-preparation", async (params) => {
      const sql = observeHostDataSql();
      try {
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
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
      const f = await fixture();
      await f.seed();
      const abort = new AbortController();
      const patch = patchSessionEntryCore;
      const spy = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockImplementation((target, update, options) =>
          patch(
            target,
            async (...args) => {
              const planned = await update(...args);
              if (change === "revocation") {
                abort.abort();
              } else {
                const manager = f.manager();
                if (change === "append") {
                  manager.appendMessage({ role: "user", content: "intervening", timestamp: 2 });
                } else if (change === "rewrite") {
                  manager.appendMessage({ role: "user", content: "intervening", timestamp: 2 });
                  manager.removeTrailingEntries((entry) => entry.type === "message");
                } else {
                  manager.appendResetBoundary("reset");
                }
              }
              return planned;
            },
            options,
          ),
        );
      await f.withRun(
        "changed-preparation",
        async (params) => {
          await expect(
            prepareCliHistoryBoundary(params, {
              credential: { type: "token", provider: "test-cli", token: "epoch-a" },
            }),
          ).rejects.toThrow();
          if (change === "append" || change === "rewrite") {
            expect(spy).toHaveBeenCalledTimes(2);
          } else if (change === "revocation") {
            expect(spy).toHaveBeenCalledOnce();
          }
          expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).not.toBe(params.runId);
        },
        { abortSignal: abort.signal },
      );
    },
  );

  it.each(["append", "rewrite"] as const)(
    "plans again after one late %s instead of failing the turn",
    async (change) => {
      const f = await fixture();
      await f.seed();
      const patch = patchSessionEntryCore;
      const spy = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockImplementationOnce((target, update, options) =>
          patch(
            target,
            async (...args) => {
              const planned = await update(...args);
              // A finished run settles its own rows after the lane moved on.
              const manager = f.manager();
              if (change === "append") {
                manager.appendMessage({ role: "user", content: "late settle", timestamp: 2 });
              } else {
                manager.removeTrailingEntries((entry) => entry.type === "message");
              }
              return planned;
            },
            options,
          ),
        );
      await f.withRun("replanned-preparation", async (params) => {
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
        // The fresh plan judges the settled transcript: an unproven foreign row stays
        // unknown, while an emptied context may start a new boundary.
        expect(Boolean(writer)).toBe(change === "rewrite");
      });
    },
  );

  it("retains same-account raw and compacted history without exposing private metadata", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private canary");
      const manager = f.manager();
      const leaf = manager.getLeafId();
      if (!leaf) {
        throw new Error("Missing seeded transcript leaf");
      }
      manager.appendCompaction("A private summary", leaf, 1000);
    });
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private summary");
    });
    const entry: InternalSessionEntry | undefined = loadSessionEntryReadOnly(f.target);
    expect(entry?.cliHistoryBoundary?.state).toBe("known");
    if (!entry) {
      throw new Error("Missing session");
    }
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("cliHistoryBoundary");
  });

  it.each([false, true])(
    "keeps compacted history only when the complete source is account-owned (foreign tail: %s)",
    async (foreignTail) => {
      const f = await fixture();
      await f.seed();
      const retained = await f.run("epoch-a", async () =>
        f.manager().appendMessage({
          role: "user",
          content: "Retained recent turn",
          timestamp: 2,
        }),
      );
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
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false), {}, credential);
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "named account", timestamp: 1 });
      },
      {},
      { ...credential, accountId: "account-a" },
    );
    await f.run(
      undefined,
      async (allowed, params) => {
        expect(await history(allowed, params)).toContain("named account");
      },
      {},
      { ...credential, accountId: "account-a", access: "rotated-access" },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { ...credential, accountId: "account-b" },
    );
  });

  it("compares resolved static tokens rather than the unchanged SecretRef", async () => {
    const f = await fixture();
    const tokenRef = { source: "env" as const, provider: "default", id: "TEST_TOKEN" };
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "prior token", timestamp: 1 });
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
    expect(() =>
      runWithCliHistoryWriter(writer, () =>
        f.manager().appendMessage({
          role: "user",
          content: "late write",
          timestamp: 1,
        }),
      ),
    ).toThrow();
    expect(f.manager().getEntries()).toEqual(before);
  });

  it("detaches background persistence without lending it the closed CLI history proof", async () => {
    const f = await fixture();
    const release = createDeferred();
    const { background } = await f.run("epoch-a", async () => ({
      background: runWithoutOwnedSessionTranscriptWrites(async () => {
        await release.promise;
        f.manager().appendMessage({ role: "user", content: "detached result", timestamp: 1 });
      }),
    }));
    release.resolve();
    await expect(background).resolves.toBeUndefined();
    expect(JSON.stringify(f.manager().getEntries())).toContain("detached result");
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("cannot launder mixed history by returning to the original account", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed, params) => {
      expect(await history(allowed, params)).toBeUndefined();
      f.manager().appendMessage({ role: "user", content: "B private canary", timestamp: 2 });
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
      const f = await fixture();
      await f.seed();
      if (change === "unrecorded append") {
        // Models run by an older binary cannot advance the new coverage proof.
        f.manager().appendMessage({ role: "user", content: "unverified account", timestamp: 2 });
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
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed) => expect(allowed).toBe(false));
    f.manager().appendResetBoundary("reset");
    await f.run("epoch-b", async (allowed) => {
      expect(allowed).toBe(true);
      f.manager().appendMessage({ role: "user", content: "B fresh canary", timestamp: 2 });
    });
    await f.run("epoch-b", async (allowed, params) => {
      const prompt = await history(allowed, params);
      expect(prompt).toContain("B fresh canary");
      expect(prompt).not.toContain("A private canary");
    });
  });

  it("admits a finished writer's successor while refusing the live writer", async () => {
    const f = await fixture();
    await f.seed();
    const identity = {
      credential: { type: "token" as const, provider: "test-cli", token: "epoch-a" },
    };
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
        // A predecessor that never settles is still refused, after the bounded wait.
        useOwnerSettleFakeTimers();
        const startedAt = Date.now();
        const refusal = runWithModelFallback({
          cfg: undefined,
          provider: "test-cli",
          model: "fixture-model",
          manifestPlugins: [],
          fallbacksOverride: ["fixture-next/fixture-model"],
          run,
        });
        await driveOwnerSettleTimers(refusal);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15_000);
        vi.useRealTimers();
        await expect(refusal).rejects.toBeInstanceOf(CliHistoryOwnerChangedError);
        await expect(refusal).rejects.toMatchObject({ kind: "live-writer" });
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
        expect(
          getOwnedSessionTranscriptWriterFence({
            sessionTarget: { ...f.target, storePath: path.join(f.target.storePath, "other") },
          }),
        ).toBeUndefined();
        expect(await history(true, params)).toContain("A private canary");
        const result = await persistCliAssistantTranscript({
          runParams: { ...params, persistAssistantTranscript: true },
          text: "recovered CLI answer",
          modelId: "test-model",
          stopReason: "stop",
        });
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

  it("waits for a settling predecessor, then prepares once and persists the follow-up", async () => {
    const f = await fixture();
    await f.seed();
    const claimed = createDeferred<void>();
    const settle = createDeferred<void>();
    const prior = f.withRun("orchestrator-prior", async (params) => {
      await claimAgentSessionWriter(params);
      claimed.resolve();
      await settle.promise;
    });
    await claimed.promise;
    const attempts = vi.spyOn(sessionAccessor, "patchSessionEntryCore");
    useOwnerSettleFakeTimers();
    await f.withRun("direct-cli-followup", async (params) => {
      params.sessionEntry = loadSessionEntryReadOnly(f.target);
      const pending = prepareCliHistoryBoundary(params, {
        credential: { type: "token", provider: "test-cli", token: "epoch-a" },
      });
      // Refused, waited and replanned against the still-live predecessor at least once.
      await driveOwnerSettleTimers(pending, () => attempts.mock.calls.length >= 2);
      expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Still waiting: nothing adopted while the predecessor is live.
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe("orchestrator-prior");
      settle.resolve();
      await prior;
      await driveOwnerSettleTimers(pending);
      vi.useRealTimers();
      const writer = await pending;
      expect(writer).toBeDefined();
      if (!writer) {
        throw new Error("Missing admitted history writer");
      }
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
      const committed = attempts.mock.calls.length;
      await runWithCliHistoryWriter(writer, async () => {
        expect(await history(true, params)).toContain("A private canary");
        const result = await persistCliAssistantTranscript({
          runParams: { ...params, persistAssistantTranscript: true },
          text: "settled follow-up answer",
          modelId: "test-model",
          stopReason: "stop",
        });
        expect(result.terminalAnchor).toBeDefined();
      });
      expect(attempts.mock.calls.length).toBe(committed);
    });
    const persisted = JSON.stringify(f.manager().getEntries());
    expect(persisted.split("settled follow-up answer")).toHaveLength(2);
  });

  it("refuses a lifecycle revision mismatch at once without waiting", async () => {
    const f = await fixture();
    await f.seed();
    const before = loadSessionEntryReadOnly(f.target);
    const spy = vi.spyOn(sessionAccessor, "patchSessionEntryCore");
    useOwnerSettleFakeTimers();
    const startedAt = Date.now();
    await f.withRun(
      "direct-cli-stale-lifecycle",
      async (params) => {
        const refusal = prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        // Real turns only: a terminal conflict must settle without any virtual time passing.
        const state = { settled: false };
        void refusal.then(
          () => (state.settled = true),
          () => (state.settled = true),
        );
        for (let turn = 0; !state.settled && turn < 2_000; turn += 1) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        expect(state.settled).toBe(true);
        await expect(refusal).rejects.toBeInstanceOf(CliHistoryOwnerChangedError);
        await expect(refusal).rejects.toMatchObject({ kind: "replaced" });
      },
      { expectedLifecycleRevision: "stale-lifecycle" },
    );
    // The settle wait only advances under virtual time, which never moved here.
    expect(Date.now()).toBe(startedAt);
    expect(spy).toHaveBeenCalledOnce();
    expect(loadSessionEntryReadOnly(f.target)).toEqual(before);
  });

  it.each(["revoked", "aborted"] as const)(
    "fails a follow-up %s during the settle wait without reading history or appending",
    async (change) => {
      const f = await fixture();
      await f.seed();
      const claimed = createDeferred<void>();
      const settle = createDeferred<void>();
      const prior = f.withRun("orchestrator-prior", async (params) => {
        await claimAgentSessionWriter(params);
        claimed.resolve();
        await settle.promise;
      });
      await claimed.promise;
      const beforeEntry = loadSessionEntryReadOnly(f.target);
      const beforeTranscript = f.manager().getEntries();
      const abort = new AbortController();
      const reads = vi.spyOn(sessionAccessor, "patchSessionEntryCore");
      useOwnerSettleFakeTimers();
      try {
        await f.withRun(
          "direct-cli-followup",
          async (params, revoke) => {
            const pending = prepareCliHistoryBoundary(params, {
              credential: { type: "token", provider: "test-cli", token: "epoch-a" },
            });
            // Refused at least once and parked in the settle wait.
            await driveOwnerSettleTimers(pending, () => reads.mock.calls.length >= 2);
            const attempts = reads.mock.calls.length;
            expect(attempts).toBeGreaterThanOrEqual(2);
            if (change === "revoked") {
              revoke();
            } else {
              abort.abort();
            }
            // The predecessor settles too, so only the recheck can stop the replan.
            settle.resolve();
            await prior;
            await driveOwnerSettleTimers(pending);
            vi.useRealTimers();
            await expect(pending).rejects.toThrow();
            expect(reads.mock.calls.length).toBe(attempts);
            const result = await persistCliAssistantTranscript({
              runParams: {
                ...params,
                // The writer fence this run would have carried had it adopted the row.
                expectedWriterRunId: params.runId,
                persistAssistantTranscript: true,
              },
              text: "late follow-up answer",
              modelId: "test-model",
              stopReason: "stop",
            }).catch(() => undefined);
            // The row was never adopted, so a late answer fenced to this run is refused.
            expect(result?.terminalAnchor).toBeUndefined();
          },
          { abortSignal: abort.signal },
        );
      } finally {
        settle.resolve();
        await prior;
      }
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).not.toBe("direct-cli-followup");
      expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary).toEqual(
        beforeEntry?.cliHistoryBoundary,
      );
      expect(f.manager().getEntries()).toEqual(beforeTranscript);
    },
  );

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
    const f = await fixture();
    await f.seed();
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
    const patch = patchSessionEntryCore;
    vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementation(
      (target, update, options) =>
        patch(
          target,
          async (...args) => {
            const prepared = await update(...args);
            await replacement.admit("embedded");
            return prepared;
          },
          options,
        ),
    );
    try {
      useOwnerSettleFakeTimers();
      await f.withRun("direct-cli-recovery", async (params) => {
        const refusal = prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        // The revived writer stays live, so the bounded wait expires and refuses.
        await driveOwnerSettleTimers(refusal);
        await expect(refusal).rejects.toThrow("CLI history owner changed before preparation");
      });
      expect(loadSessionEntryReadOnly(f.target)).toEqual(before);
    } finally {
      replacement.close();
    }
  });

  it.each(["orchestrator-prior", "orchestrator-replacement", "direct-cli-recovery"])(
    "fences recovered history and CLI persistence after %s takes over",
    async (replacementRunId) => {
      const f = await fixture();
      await f.seed();
      await f.withRun("orchestrator-prior", async (params) => {
        await claimAgentSessionWriter(params);
      });
      await f.withRun("direct-cli-recovery", async (params) => {
        params.sessionEntry = loadSessionEntryReadOnly(f.target);
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
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
            const result = await persistCliAssistantTranscript({
              runParams: { ...params, persistAssistantTranscript: true },
              text: "late recovered CLI answer",
              modelId: "test-model",
              stopReason: "stop",
            });
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
