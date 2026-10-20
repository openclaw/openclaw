import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beamTestNow,
  beamMirrorTestFixture,
  beamTestHandler,
  createBeamTestCatalog,
  createBeamTestRunner,
  persistentBeamTestStore,
  type BeamTestSession,
} from "./beam.test-support.js";
import { beamMirrorId } from "./mirror.js";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS, type BeamUpload } from "./types.js";

let fixture: ReturnType<typeof beamMirrorTestFixture>;
let clock: number;
let activeSessions: BeamTestSession[];
const sessions = (ids: string[], recencyAt: number) =>
  ids.map((threadId) => ({ threadId, recencyAt }));
beforeEach(() => {
  fixture = beamMirrorTestFixture();
  clock = beamTestNow;
  activeSessions = sessions(["t1"], beamTestNow - 60_000);
});

function createRetryRunner(statusFor = (payload: BeamUpload) => (payload.completed ? 503 : 200)) {
  return fixture.runner(
    {
      sessions: () => activeSessions,
      items: (threadId) => [{ type: "agentMessage", text: threadId }],
    },
    {
      endpoint: "http://127.0.0.1:19351/api/v1/beam/sessions",
      now: () => clock,
    },
    { status: statusFor },
  );
}

describe("Beam terminal retry policy", () => {
  it("expires failed terminal work with the receiver row", async () => {
    const runner = createRetryRunner();
    await runner.tick();
    activeSessions = [];
    clock += 4 * 60 * 60_000;
    await runner.tick();
    clock = beamTestNow + BEAM_RETENTION_MS;
    await runner.tick();
    await runner.tick();

    expect(fixture.sent.map(({ payload }) => payload.completed)).toEqual([false, true]);
  });

  it("rotates failed terminal work behind later sessions", async () => {
    activeSessions = sessions(
      Array.from({ length: 32 }, (_, index) => `early-${index}`),
      clock - 60_000,
    );
    const runner = createRetryRunner();
    await runner.tick();
    clock += 60_000;
    activeSessions = sessions(["late"], clock - 60_000);
    await runner.tick();
    activeSessions = [];
    clock += 60_000;
    const beforeLaterRetry = fixture.sent.length;
    await runner.tick();
    const laterRetries = fixture.sent.slice(beforeLaterRetry);

    expect(laterRetries).toHaveLength(32);
    expect(laterRetries.map(({ payload }) => payload.beamId)).toContain(
      beamMirrorId("claude", "gateway:local", "late"),
    );
  });

  it("does not retry a failed terminal upload for an active overflow session", async () => {
    const overflowThreadId = "active-overflow";
    const overflowBeamId = beamMirrorId("claude", "gateway:local", overflowThreadId);
    activeSessions = sessions([overflowThreadId], beamTestNow);
    const runner = createRetryRunner(() => 200);

    await runner.tick();
    activeSessions = [
      ...Array.from({ length: 32 }, (_, index) => ({
        threadId: `newer-${index}`,
        recencyAt: beamTestNow + index + 1,
      })),
      { threadId: overflowThreadId, recencyAt: beamTestNow },
    ];
    await runner.tick();
    await runner.tick();

    expect(
      fixture.sent
        .filter(({ payload }) => payload.beamId === overflowBeamId)
        .map(({ payload }) => payload.completed),
    ).toEqual([false]);
  });

  it("keeps receiver-retained retry state with independent clocks", async () => {
    const targetThreadId = "session-273";
    const targetBeamId = beamMirrorId("claude", "gateway:local", targetThreadId);
    const { store: receiverStore, close } = persistentBeamTestStore("beam-capacity");
    const acceptedTargetStates: boolean[] = [];
    let phase: "build" | "final" = "build";
    let rejectedTargetWrites = 0;
    const store: BeamStore = {
      ...receiverStore,
      upload: async (session, receipt) => {
        if (session.completed && phase === "build") {
          throw new Error("hold terminal state while filling capacity");
        }
        if (session.completed && session.beamId === targetBeamId && rejectedTargetWrites === 0) {
          rejectedTargetWrites += 1;
          throw new Error("temporary target terminal failure");
        }
        if (session.completed && phase === "final" && session.beamId !== targetBeamId) {
          throw new Error("hold non-target terminal state");
        }
        const accepted = await receiverStore.upload(session, receipt);
        if (accepted && session.beamId === targetBeamId) {
          acceptedTargetStates.push(session.completed);
        }
        return accepted;
      },
    };
    let requestNumber = 0;
    const handler = beamTestHandler(
      store,
      {
        resolveClient: () => ({
          clientIp: `capacity-test-${++requestNumber}`,
          scopes: ["operator.write"],
        }),
        resolveControlUiBasePath: () => "",
      },
      503,
    );
    try {
      await withServer(handler, async (baseUrl) => {
        activeSessions = [];
        const catalog = createBeamTestCatalog({
          sessions: () => activeSessions,
          items: (threadId) => [{ type: "agentMessage", text: threadId }],
        });
        const runner = createBeamTestRunner({
          endpoint: `${baseUrl}/api/v1/beam/sessions`,
          listCatalogs: () => [catalog],
        });
        let createdSessions = 0;
        for (let batch = 0; createdSessions < BEAM_MAX_SESSIONS; batch += 1) {
          const batchSize = Math.min(32, BEAM_MAX_SESSIONS - createdSessions);
          activeSessions = Array.from({ length: batchSize }, (_, index) => ({
            threadId: `session-${createdSessions + index}`,
            recencyAt: beamTestNow + batch,
          }));
          createdSessions += batchSize;
          await runner.tick();
        }

        activeSessions = [{ threadId: "session-500", recencyAt: beamTestNow + 101 }];
        await runner.tick();
        await expect(store.get(targetBeamId)).resolves.toMatchObject({ completed: false });

        activeSessions = [];
        phase = "final";
        for (let tick = 0; tick < 40; tick += 1) {
          await runner.tick();
        }

        expect(rejectedTargetWrites).toBe(1);
        expect(acceptedTargetStates).toEqual([false, true]);
        await expect(store.get(targetBeamId)).resolves.toMatchObject({ completed: true });
      });
    } finally {
      await close();
    }
  });
});
