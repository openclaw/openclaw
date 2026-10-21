import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return {
    card,
    dispatch,
    prepared,
    runResult,
    replacementStore: new WorkboardStore(stores.cards, sqliteTestAuxStores(stores)),
  };
}

async function rejectInterruptedDispatch(
  interrupted: Awaited<ReturnType<typeof beginPreparedDispatch>>,
) {
  interrupted.runResult.reject(new Error("simulated dispatcher process loss"));
  await interrupted.dispatch;
}

let interrupted: Awaited<ReturnType<typeof beginPreparedDispatch>>;
let canonicalSessionKey: string;
let lifecycle: Awaited<ReturnType<typeof sweep>> | undefined;
const read = () => interrupted.replacementStore.get(interrupted.card.id);

beforeEach(async () => {
  interrupted = await beginPreparedDispatch();
  canonicalSessionKey = `agent:worker:${interrupted.prepared.sessionKey}`;
});
afterEach(async () => {
  try {
    if (lifecycle) {
      lifecycle.stop();
    }
  } finally {
    try {
      await rejectInterruptedDispatch(interrupted);
    } finally {
      await lifecycle?.[Symbol.asyncDispose]();
      lifecycle = undefined;
      await interrupted.replacementStore.close();
    }
  }
});
async function sweep({
  sessions,
  complete = true,
}: Omit<LifecycleSnapshot, "complete"> & { complete?: boolean }) {
  const readSessions = vi.fn().mockResolvedValue({ sessions, complete });
  const active = lifecycleFixture({
    store: interrupted.replacementStore,
    readSessions,
  });
  await active.start();
  const result = { ...active, readSessions };
  lifecycle = result;
  return result;
}

describe("Workboard prepared launch restart recovery", () => {
  it.each(["running", "done"] as const)(
    "fails a prepared %s session without acceptance evidence",
    async (status) => {
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
      await rejectInterruptedDispatch(interrupted);
    },
  );

  it("accepts a prepared launch found under its canonical post-restart session", async () => {
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

    await syncWorkboardSubagentEnded({
      store: interrupted.replacementStore,
      event: {
        targetSessionKey: canonicalSessionKey,
        runId: "accepted-run",
        outcome: "ok",
      },
    });
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
    await rejectInterruptedDispatch(interrupted);
    expect((await read())?.status).toBe("review");
  });

  it("accepts a prepared launch from an explicit terminal session snapshot", async () => {
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
    await rejectInterruptedDispatch(interrupted);
  });

  it.each(["incomplete", "ambiguous"] as const)(
    "keeps a prepared launch running when the post-restart snapshot is %s",
    async (snapshot) => {
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
      await rejectInterruptedDispatch(interrupted);
    },
  );
});
