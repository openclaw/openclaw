import { describe, expect, test } from "vitest";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

describe("common-work runtime adapter", () => {
  test("persists admission through terminal callback and authoritative delivery read-back", async () => {
    const store: WorkboardStore = createStore();
    const card = await store.create({ title: "common work" });
    const route = { channelId: "C1", threadId: "1.1", version: 1 };
    let result = await store.transitionCommonWork(card.id, {
      kind: "admit",
      admission: {
        workId: "W1",
        requestKey: "R1",
        requestDigest: "sha256:1",
        goal: "finish",
        objectiveDigest: "sha256:finish",
        scope: ["runtime adapter"],
        acceptanceCriteria: ["terminal delivery is persisted"],
        reportingLeadAgentId: "dev",
        ownerAgentId: "dev",
        lane: "common",
        sourceSessionKey: "source",
        callbackSessionKey: "parent",
        userRoute: route,
        routeFamily: "common-work",
        routeSequence: 12,
      },
    });
    expect(result.card.metadata?.commonWork?.revision).toBe(1);
    await store.transitionCommonWork(card.id, {
      kind: "attach",
      expectedRevision: 1,
      executionId: "E1",
      generation: 1,
      sessionKey: "worker",
    });
    result = await store.transitionCommonWork(card.id, {
      kind: "terminal",
      expectedRevision: 2,
      executionId: "E1",
      generation: 1,
      status: "done",
      terminalReceipt: "terminal:1",
    });
    expect(result.card.metadata?.commonWork?.responsibility).toBe("return_pending");
    result = await store.transitionCommonWork(card.id, {
      kind: "callback",
      expectedRevision: 3,
      dedupeKey: "callback:1",
      receipt: "parent:1",
      targetSessionKey: "parent",
    });
    expect(result.terminalRelayComplete).toBe(false);
    result = await store.transitionCommonWork(card.id, {
      kind: "delivery",
      expectedRevision: 4,
      route,
      receipt: "delivery:1",
    });
    expect(result.terminalRelayComplete).toBe(true);
    expect((await store.get(card.id))?.metadata?.commonWork?.deliveryReceipt).toBe("delivery:1");
    const replay = await store.transitionCommonWork(card.id, {
      kind: "delivery",
      expectedRevision: 5,
      route,
      receipt: "delivery:1",
    });
    expect(replay.changed).toBe(false);
    expect(replay.terminalRelayComplete).toBe(true);
  });
});
