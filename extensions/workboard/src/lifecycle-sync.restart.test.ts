import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import {
  lifecycleSession,
  lifecycleFixture,
  type LifecycleSnapshot,
} from "./lifecycle-sync-fixtures.test-support.js";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness, sqliteTestAuxStores } from "./test/sqlite-store.js";

async function beginPreparedDispatch() {
  const { store: dispatchStore, stores } = createWorkboardSqliteTestHarness();
  const card = await dispatchStore.create({
    title: "Prepared across restart",
    status: "ready",
    workspaceAccess: { unrestricted: true },
  });
  const reachedRun = Promise.withResolvers<{ sessionKey: string; provisionalRunId: string }>();
  const runResult = Promise.withResolvers<{ sessionKey?: string; runId: string }>();
  const dispatch = dispatchAndStartWorkboardCards({
    store: dispatchStore,
    subagent: {
      run: vi.fn(async (input) => {
        reachedRun.resolve({
          sessionKey: input.sessionKey,
          provisionalRunId: input.idempotencyKey,
        });
        return await runResult.promise;
      }),
    },
    options: { maxStarts: 1 },
  });
  const prepared = await reachedRun.promise;
  const replacementStore = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
  let lifecycle: ReturnType<typeof lifecycleFixture> | undefined;
  const interrupt = async () => {
    runResult.reject(new Error("simulated dispatcher process loss"));
    await dispatch;
  };
  return {
    prepared,
    canonicalSessionKey: `agent:worker:${prepared.sessionKey}`,
    read: () => replacementStore.get(card.id),
    end: () =>
      syncWorkboardSubagentEnded({
        store: replacementStore,
        event: {
          targetSessionKey: `agent:worker:${prepared.sessionKey}`,
          runId: "accepted-run",
          outcome: "ok",
        },
      }),
    interrupt,
    async sweep({
      sessions,
      complete = true,
    }: Omit<LifecycleSnapshot, "complete"> & { complete?: boolean }) {
      const readSessions = vi.fn().mockResolvedValue({ sessions, complete });
      const active = lifecycleFixture({ store: replacementStore, readSessions });
      lifecycle = active;
      await active.start();
      return { ...active, readSessions };
    },
    async [Symbol.asyncDispose]() {
      lifecycle?.stop();
      try {
        await interrupt();
      } finally {
        await lifecycle?.[Symbol.asyncDispose]();
        await replacementStore.close();
      }
    },
  };
}

describe("Workboard prepared launch restart recovery", () => {
  it.each(["running", "done"] as const)(
    "fails a prepared %s session without acceptance evidence",
    async (status) => {
      await using interrupted = await beginPreparedDispatch();
      const { read, sweep, canonicalSessionKey } = interrupted;
      const active = await sweep({ sessions: [lifecycleSession(canonicalSessionKey, status)] });
      await active.sweep();
      active.stop();
      await expect(read()).resolves.toMatchObject({
        status: "blocked",
        metadata: { automation: { launch: { phase: "failed" } } },
      });
      if (status === "running") {
        expect((await read())?.metadata?.claim).toBeUndefined();
      }
      await interrupted.interrupt();
    },
  );

  it("accepts a prepared launch found under its canonical post-restart session", async () => {
    await using interrupted = await beginPreparedDispatch();
    const { read, sweep, canonicalSessionKey } = interrupted;
    const active = await sweep({
      sessions: [lifecycleSession(canonicalSessionKey, "running", undefined, true)],
    });

    expect(active.readSessions).not.toHaveBeenCalled();
    await active.sweep();

    const accepted = await read();
    const attempt = {
      status: "running",
      sessionKey: canonicalSessionKey,
      runId: interrupted.prepared.provisionalRunId,
    };
    expect(accepted).toMatchObject({
      ...attempt,
      metadata: {
        claim: { ownerId: "workboard-dispatcher" },
        attempts: [attempt],
        automation: { launch: { phase: "accepted", acceptedSessionKey: canonicalSessionKey } },
      },
    });
    expect(accepted?.metadata?.automation?.launch).not.toHaveProperty("acceptedRunId");

    await interrupted.end();
    const terminal = await read();
    expect(terminal).toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      runId: "accepted-run",
      metadata: {
        automation: { launch: { phase: "accepted", acceptedRunId: "accepted-run" } },
        attempts: [{ id: expect.any(String), status: "succeeded", runId: "accepted-run" }],
      },
    });
    expect(terminal?.metadata?.attempts).toHaveLength(1);
    expect(terminal?.metadata?.attempts?.[0]?.id).toBe(accepted?.metadata?.attempts?.[0]?.id);

    active.stop();
    await interrupted.interrupt();
    expect((await read())?.status).toBe("review");
  });

  it("accepts a prepared launch from an explicit terminal session snapshot", async () => {
    await using interrupted = await beginPreparedDispatch();
    const { read, sweep, canonicalSessionKey } = interrupted;
    const launch = (await read())?.metadata?.automation?.launch;
    if (launch?.phase !== "prepared") {
      throw new Error("expected prepared launch");
    }
    const active = await sweep({
      sessions: [lifecycleSession(canonicalSessionKey, "done", launch.preparedAt + 1)],
    });

    await active.sweep();
    active.stop();

    await expect(read()).resolves.toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      metadata: {
        automation: { launch: { phase: "accepted", acceptedSessionKey: canonicalSessionKey } },
        attempts: [{ status: "succeeded" }],
      },
    });
    await interrupted.interrupt();
  });

  it.each(["incomplete", "ambiguous"] as const)(
    "keeps a prepared launch running when the post-restart snapshot is %s",
    async (snapshot) => {
      await using interrupted = await beginPreparedDispatch();
      const { read, sweep } = interrupted;
      const active = await sweep({
        sessions:
          snapshot === "ambiguous"
            ? [
                { key: `agent:alpha:${interrupted.prepared.sessionKey}`, status: "done" },
                { key: `agent:beta:${interrupted.prepared.sessionKey}`, status: "done" },
              ]
            : [],
        complete: snapshot === "ambiguous",
      });

      await active.sweep();
      expect(active.readSessions).toHaveBeenCalledOnce();
      await expect(read()).resolves.toMatchObject({
        status: "running",
        sessionKey: interrupted.prepared.sessionKey,
        runId: interrupted.prepared.provisionalRunId,
        metadata: {
          claim: { ownerId: "workboard-dispatcher" },
          automation: { launch: { phase: "prepared" } },
        },
      });

      active.stop();
      await interrupted.interrupt();
    },
  );
});
