import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { ContinuityEngine, DestinationFixture } from "./engine.js";
import type {
  ActivityState,
  AdmittedOperation,
  ConsistencyMode,
  DestinationState,
  Direction,
  OperationReceipt,
  StepCount,
} from "./types.js";

/** The public sync keyed-store contract, not a claim of SQLite persistence proof. */
function transactionalStore<T>(): PluginStateSyncKeyedStore<T> {
  const records = new Map<string, T>();
  const read = (key: string) => {
    const value = records.get(key);
    return value === undefined ? undefined : structuredClone(value);
  };
  return {
    register: (key, value) => {
      records.set(key, structuredClone(value));
    },
    registerIfAbsent: (key, value) => {
      if (records.has(key)) {
        return false;
      }
      records.set(key, structuredClone(value));
      return true;
    },
    update: (key, change) => {
      const next = change(read(key));
      if (next === undefined) {
        return false;
      }
      records.set(key, structuredClone(next));
      return true;
    },
    lookup: read,
    consume: (key) => {
      const value = read(key);
      records.delete(key);
      return value;
    },
    delete: (key) => records.delete(key),
    entries: () =>
      Array.from(records, ([key, value]) => ({ key, value: structuredClone(value), createdAt: 1 })),
    clear: () => records.clear(),
  };
}

function setup(mode: ConsistencyMode = "next-turn", targetSteps: StepCount = 1) {
  const homeStore = transactionalStore<ActivityState>();
  const destinationStore = transactionalStore<DestinationState>();
  const engine = new ContinuityEngine(homeStore);
  const destination = new DestinationFixture(destinationStore, "company");
  engine.enroll({
    id: "campaign-x",
    sessionKey: "session:company",
    destinationId: "company",
    mode,
    targetSteps,
  });
  destination.enroll({ id: "campaign-x", targetSteps });
  return { homeStore, destinationStore, engine, destination };
}

function propose(
  engine: ContinuityEngine,
  runId = "run-a",
  direction: Direction = "A",
  step: StepCount = 1,
): AdmittedOperation {
  engine.beginTurn("campaign-x", "session:company", runId);
  return engine.proposeOperation("campaign-x", runId, { direction, step });
}

function execute(
  engine: ContinuityEngine,
  destination: DestinationFixture,
  operation: AdmittedOperation,
): OperationReceipt {
  const dispatched = engine.markDispatched("campaign-x", operation.id);
  const receipt = destination.execute(dispatched);
  engine.settleReceipt("campaign-x", receipt);
  return receipt;
}

describe("bounded continuity state machine", () => {
  it("requires native atomic update instead of emulating it with lookup/register", () => {
    const unsupported = transactionalStore<ActivityState>();
    delete unsupported.update;
    expect(() => new ContinuityEngine(unsupported)).toThrow("transactional-store-update-required");
  });

  it.each(["next-turn", "operation"] as const)(
    "captures B when a queued turn actually starts (%s)",
    (mode) => {
      const { engine, destination } = setup(mode, 2);
      engine.acceptDecision("campaign-x", "B", "decision-b");
      const turn = engine.beginTurn("campaign-x", "session:company", "formerly-queued");
      expect(turn).toMatchObject({ direction: "B", decisionRevision: 2 });
      const first = engine.proposeOperation("campaign-x", turn.runId, { direction: "B", step: 1 });
      execute(engine, destination, first);
      const second = engine.proposeOperation("campaign-x", turn.runId, { direction: "B", step: 2 });
      execute(engine, destination, second);
      engine.finishTurn("campaign-x", turn.runId);

      expect(engine.get("campaign-x")).toMatchObject({
        status: "completed",
        completedSteps: [1, 2],
      });
      expect(destination.get("campaign-x").artifacts.map((artifact) => artifact.text)).toEqual([
        "Synthetic B step 1 for campaign-x",
        "Synthetic B step 2 for campaign-x",
      ]);
    },
  );

  it("lets an active A turn finish in next-turn mode without closing newer B work", () => {
    const { engine, destination } = setup();
    engine.beginTurn("campaign-x", "session:company", "run-a");
    engine.acceptDecision("campaign-x", "B", "decision-b");
    const operation = engine.proposeOperation("campaign-x", "run-a", { direction: "A", step: 1 });
    execute(engine, destination, operation);
    engine.finishTurn("campaign-x", "run-a");
    expect(engine.get("campaign-x")).toMatchObject({
      currentDecision: { direction: "B", revision: 2 },
      completedSteps: [],
      status: "pending",
    });

    const next = propose(engine, "run-b", "B");
    execute(engine, destination, next);
    expect(engine.get("campaign-x").status).toBe("completed");
    expect(destination.get("campaign-x").artifacts.map((artifact) => artifact.direction)).toEqual([
      "A",
      "B",
    ]);
  });

  it("rejects proposals from an active A turn after B in operation mode", () => {
    const { engine } = setup("operation");
    engine.beginTurn("campaign-x", "session:company", "run-a");
    engine.acceptDecision("campaign-x", "B", "decision-b");
    expect(() =>
      engine.proposeOperation("campaign-x", "run-a", { direction: "A", step: 1 }),
    ).toThrow("decision-superseded");
    expect(engine.get("campaign-x").operations).toEqual([]);
  });

  it("cancels locally controlled old admissions but reports already-dispatched A honestly", () => {
    const { engine, destination } = setup("operation");
    const admitted = propose(engine);
    engine.acceptDecision("campaign-x", "B", "decision-b");
    expect(() => engine.markDispatched("campaign-x", admitted.id)).toThrow(
      "operation-not-ready-for-dispatch",
    );
    const b = propose(engine, "run-b", "B");
    engine.markDispatched("campaign-x", b.id);
    engine.acceptDecision("campaign-x", "A", "decision-a-again");
    engine.settleReceipt("campaign-x", destination.execute(b));
    expect(engine.get("campaign-x")).toMatchObject({
      currentDecision: { revision: 3, direction: "A" },
      completedSteps: [],
    });
    expect(destination.get("campaign-x").artifacts).toHaveLength(1);
  });

  it("is idempotent for an exact decision request but rejects reuse for different content", () => {
    const { engine } = setup();
    const decision = engine.acceptDecision("campaign-x", "B", "request-b");
    expect(engine.acceptDecision("campaign-x", "B", "request-b")).toEqual(decision);
    expect(() => engine.acceptDecision("campaign-x", "A", "request-b")).toThrow(
      "decision-idempotency-conflict",
    );
    expect(engine.get("campaign-x").decisions).toHaveLength(2);
  });

  it("bounds decision records without evicting old replay identities", () => {
    const { engine } = setup();
    for (let index = 0; index < 31; index += 1) {
      engine.acceptDecision("campaign-x", index % 2 ? "A" : "B", `decision-${index}`);
    }
    expect(() => engine.acceptDecision("campaign-x", "B", "overflow")).toThrow(
      "decision-capacity-exhausted",
    );
    expect(engine.acceptDecision("campaign-x", "B", "decision-0").revision).toBe(2);
    expect(engine.get("campaign-x").decisions).toHaveLength(32);
  });

  it.each(["admitted", "dispatched"] as const)(
    "keeps receipt retries bound to the original effect from %s",
    (localState) => {
      const { engine, destination } = setup();
      const operation = propose(engine);
      expect(engine.proposeOperation("campaign-x", "run-a", { direction: "A", step: 1 })).toEqual(
        operation,
      );
      if (localState === "dispatched") {
        engine.markDispatched("campaign-x", operation.id);
      }
      // An admin reconciliation report may arrive without local dispatch bookkeeping.
      const receipt = destination.execute(operation);
      engine.settleReceipt("campaign-x", receipt);
      expect(engine.get("campaign-x").status).toBe("completed");
      expect(destination.execute(operation)).toEqual(receipt);
      const reordered: OperationReceipt = {
        artifactId: receipt.artifactId,
        reason: receipt.reason,
        outcome: receipt.outcome,
        destinationRevision: receipt.destinationRevision,
        destinationId: receipt.destinationId,
        activityId: receipt.activityId,
        operationHash: receipt.operationHash,
        operationId: receipt.operationId,
      };
      engine.settleReceipt("campaign-x", reordered);
      expect(engine.get("campaign-x").operations).toHaveLength(1);
      expect(destination.get("campaign-x").artifacts).toHaveLength(1);
    },
  );

  it("rejects altered operation content and wrong bound receipts", () => {
    const { engine, destination } = setup();
    const operation = propose(engine);
    expect(() => destination.execute({ ...operation, direction: "B" })).toThrow(
      "operation-binding-mismatch",
    );
    const receipt = execute(engine, destination, operation);
    expect(() =>
      engine.settleReceipt("campaign-x", { ...receipt, operationHash: "wrong" }),
    ).toThrow("receipt-binding-mismatch");
    expect(destination.get("campaign-x").artifacts).toHaveLength(1);
  });

  it("reconciles an executed effect after restart and lost acknowledgement without retrying it", () => {
    const { engine, destination, homeStore } = setup();
    const operation = propose(engine);
    engine.markDispatched("campaign-x", operation.id);
    destination.execute(operation);
    const restarted = new ContinuityEngine(homeStore);
    restarted.recover();
    expect(restarted.get("campaign-x")).toMatchObject({
      status: "blocked",
      blockedReason: "outcome-unknown",
    });
    restarted.beginTurn("campaign-x", "session:company", "recovery-run");
    expect(() =>
      restarted.proposeOperation("campaign-x", "recovery-run", { direction: "A", step: 1 }),
    ).toThrow("reconciliation-required");
    const status = destination.status("campaign-x", operation.id);
    expect(status.outcome).toBe("found");
    if (status.outcome !== "found") {
      throw new Error("receipt missing");
    }
    restarted.settleReceipt("campaign-x", status.receipt);
    expect(restarted.get("campaign-x").status).toBe("completed");
    expect(destination.get("campaign-x").artifacts).toHaveLength(1);
  });

  it.each(["admitted", "dispatched"] as const)(
    "keeps %s uncertainty blocked until a cancellation tombstone fences delayed delivery",
    (localState) => {
      const { engine, destination, homeStore } = setup();
      const operation = propose(engine);
      if (localState === "dispatched") {
        engine.markDispatched("campaign-x", operation.id);
      } else {
        engine.markUnknown("campaign-x", operation.id);
        expect(engine.get("campaign-x").operations[0]?.state).toBe("outcome-unknown");
        expect(() => engine.markDispatched("campaign-x", operation.id)).toThrow(
          "operation-not-ready-for-dispatch",
        );
        expect(() =>
          engine.proposeOperation("campaign-x", "run-a", { direction: "A", step: 1 }),
        ).toThrow("reconciliation-required");
      }
      const restarted = new ContinuityEngine(homeStore);
      restarted.recover();
      expect(destination.status("campaign-x", operation.id)).toEqual({ outcome: "not-found" });
      expect(restarted.get("campaign-x").blockedReason).toBe("outcome-unknown");
      const cancelled = destination.cancel(
        restarted.requestCancellation("campaign-x", operation.id),
      );
      restarted.settleReceipt("campaign-x", cancelled);
      expect(destination.execute(operation).outcome).toBe("cancelled");
      restarted.acceptDecision("campaign-x", "B", "decision-b");
      execute(restarted, destination, propose(restarted, "run-b", "B"));
      expect(destination.get("campaign-x").artifacts.map((artifact) => artifact.direction)).toEqual(
        ["B"],
      );
      expect(restarted.get("campaign-x").status).toBe("completed");
    },
  );

  it("preserves unfinished responsibility after a restart with no operation dispatched", () => {
    const { engine, homeStore } = setup();
    engine.acceptDecision("campaign-x", "B", "decision-b");
    engine.beginTurn("campaign-x", "session:company", "interrupted-planning");
    const restarted = new ContinuityEngine(homeStore);
    restarted.recover();
    expect(restarted.get("campaign-x")).toMatchObject({
      status: "pending",
      currentDecision: { direction: "B" },
    });
    expect(restarted.beginTurn("campaign-x", "session:company", "new-turn").direction).toBe("B");
  });

  it("keeps independent activities progressing when company disconnects", () => {
    const { engine } = setup();
    engine.enroll({
      id: "family-plan",
      destinationId: "family",
      sessionKey: "session:family",
      mode: "next-turn",
    });
    engine.setAttachment("campaign-x", { connected: false });
    expect(() => engine.beginTurn("campaign-x", "session:company", "disconnected-run")).toThrow(
      "attachment-disconnected",
    );
    expect(engine.beginTurn("family-plan", "session:family", "family-run").direction).toBe("A");
  });

  it.each(["revoked", "regranted", "reattached"] as const)(
    "fences old run authority after %s",
    (scenario) => {
      const { engine } = setup();
      engine.beginTurn("campaign-x", "session:company", "old-run");
      if (scenario === "reattached") {
        engine.setAttachment("campaign-x", { connected: false });
        engine.setAttachment("campaign-x", { connected: true });
      } else {
        engine.setPolicy("campaign-x", { execute: false });
        if (scenario === "regranted") {
          engine.setPolicy("campaign-x", { execute: true });
        }
      }
      expect(() =>
        engine.proposeOperation("campaign-x", "old-run", { direction: "A", step: 1 }),
      ).toThrow(
        scenario === "revoked"
          ? "home-execute-denied"
          : scenario === "reattached"
            ? "turn-attachment-stale"
            : "turn-authority-stale",
      );
    },
  );

  it("keeps execute, status read, and cancellation permissions separate", () => {
    const { engine, destination } = setup();
    const operation = propose(engine);
    engine.markDispatched("campaign-x", operation.id);
    const receipt = destination.execute(operation);
    destination.setPolicy("campaign-x", { execute: false });
    expect(() => destination.execute(operation)).toThrow("destination-execute-denied");
    expect(destination.status("campaign-x", operation.id)).toEqual({ outcome: "found", receipt });
    engine.setPolicy("campaign-x", { execute: false });
    expect(engine.settleReceipt("campaign-x", receipt).completedSteps).toEqual([1]);
    destination.setPolicy("campaign-x", { statusRead: false, cancel: false });
    expect(() => destination.status("campaign-x", operation.id)).toThrow(
      "destination-status-denied",
    );
    expect(() => destination.cancel(operation)).toThrow("destination-cancel-denied");
  });

  it("records destination state conflicts terminally, then permits explicitly refreshed current work", () => {
    const { engine, destination } = setup();
    const operation = propose(engine);
    engine.markDispatched("campaign-x", operation.id);
    const changed = destination.changeState("campaign-x");
    const conflict = destination.execute(operation);
    expect(conflict).toMatchObject({
      outcome: "rejected",
      reason: "destination-revision-conflict",
    });
    engine.settleReceipt("campaign-x", conflict);
    expect(engine.get("campaign-x")).toMatchObject({
      status: "blocked",
      blockedReason: "destination-revision-conflict",
    });
    engine.setAttachment("campaign-x", { connected: true, destinationRevision: changed.revision });
    execute(engine, destination, propose(engine, "fresh-run"));
    expect(engine.get("campaign-x").status).toBe("completed");
    expect(destination.get("campaign-x").artifacts).toHaveLength(1);
  });

  it("requires exact session binding, decision direction, and an immediately eligible step", () => {
    const { engine } = setup("next-turn", 3);
    expect(() => engine.beginTurn("campaign-x", "session:family", "wrong-session")).toThrow(
      "turn-session-mismatch",
    );
    engine.beginTurn("campaign-x", "session:company", "run-a");
    expect(() =>
      engine.proposeOperation("campaign-x", "run-a", { direction: "B", step: 1 }),
    ).toThrow("proposal-direction-mismatch");
    expect(() =>
      engine.proposeOperation("campaign-x", "run-a", { direction: "A", step: 3 }),
    ).toThrow("proposal-step-not-ready");
    expect(engine.get("campaign-x").operations).toEqual([]);
  });

  it("explicit stop prevents fresh effects without claiming dispatched work was cancelled", () => {
    const { engine, destination } = setup();
    const operation = propose(engine);
    engine.markDispatched("campaign-x", operation.id);
    engine.stop("campaign-x");
    expect(engine.get("campaign-x").operations[0]?.state).toBe("dispatched");
    expect(() => engine.beginTurn("campaign-x", "session:company", "after-stop")).toThrow(
      "activity-stopped",
    );
    const actual = destination.execute(operation);
    engine.settleReceipt("campaign-x", actual);
    expect(engine.get("campaign-x")).toMatchObject({ status: "stopped", completedSteps: [1] });
    expect(destination.get("campaign-x").artifacts).toHaveLength(1);
  });
});
