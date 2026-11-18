import { expect, it } from "vitest";
import { captureThrown } from "../../test/helpers/capture-thrown.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { readAgentSelfHeldRefusal } from "../gateway/agent-turn/agent-admission-refusal.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { PluginInstance, type PluginReplacementOutcome } from "../plugins/plugin-instance.js";
import { watchPluginReplacement } from "../plugins/plugin-replacement-watchers.js";
import {
  assertPreparedModelRuntimeAdmissionCanWait,
  readPreparedRuntimeSelfHold,
} from "./prepared-model-runtime-admission.js";

it("captures the exact reserved operation before notification, independently of release", async () => {
  const instance = new PluginInstance("held");
  const other = new PluginInstance("held");
  const consumer = instance.retainConsumer();
  const tail = createDeferred<PluginReplacementOutcome>();
  const operation = { operationId: "replacement-one", settled: tail.promise };
  let refusal: unknown;
  const stop = watchPluginReplacement(instance, () => {
    try {
      consumer.run(() => assertPreparedModelRuntimeAdmissionCanWait());
    } catch (error) {
      refusal = error;
    }
  });
  const release = instance.reserveReplacement(operation);
  try {
    expect(refusal).toMatchObject({ admissionBlocked: true });
    const fact = readPreparedRuntimeSelfHold(new Error("transport", { cause: refusal }));
    expect(fact?.held).toEqual([{ instance, pluginId: "held", operation }]);
    expect(() => other.run(() => assertPreparedModelRuntimeAdmissionCanWait())).not.toThrow();
    expect(readAgentSelfHeldRefusal(refusal)?.admission.acceptance).toBe("uncertain");
    let settled = false;
    void fact?.held[0]?.operation.settled.then(() => {
      settled = true;
    });
    release();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => consumer.run(() => assertPreparedModelRuntimeAdmissionCanWait())).not.toThrow();
    tail.resolve({ kind: "failed", committed: true, unavailablePluginIds: ["held"] });
    await expect(fact?.held[0]?.operation.settled).resolves.toEqual({
      kind: "failed",
      committed: true,
      unavailablePluginIds: ["held"],
    });
  } finally {
    stop();
    release();
    consumer.release();
    tail.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
    await Promise.all([instance.dispose(), other.dispose()]);
  }
});

it("never recognizes a forged cause or serialized retained result as a refusal fact", () => {
  const forged = Object.assign(new Error("replacement"), { admissionBlocked: true });
  for (const value of [
    forged,
    new Error("wrapper", { cause: forged }),
    {
      status: "started",
      async: true,
      runId: "forged",
      retained: {
        acceptance: "not_accepted",
        reason: "plugin_reload_self_hold",
        plugins: ["held"],
      },
    },
  ]) {
    expect(readPreparedRuntimeSelfHold(value)).toBeUndefined();
    expect(readAgentSelfHeldRefusal(value)).toBeUndefined();
  }
});

it.each(["boolean-only", "reservation-without-operation"] as const)(
  "refuses %s holds without minting a retention proof",
  async (kind) => {
    const instance = new PluginInstance("legacy");
    const consumer = instance.retainConsumer();
    const release = instance.reserveReplacement();
    try {
      const refusal = captureThrown(
        () =>
          kind === "boolean-only"
            ? pluginInvocationContext.run(
                { holdsPendingReplacement: true, lookup: () => undefined },
                () => assertPreparedModelRuntimeAdmissionCanWait(),
              )
            : consumer.run(() => assertPreparedModelRuntimeAdmissionCanWait()),
        "Legacy holds must still refuse immediately",
      );
      expect(refusal).toMatchObject({ admissionBlocked: true });
      expect(readPreparedRuntimeSelfHold(refusal)).toBeUndefined();
      expect(readAgentSelfHeldRefusal(refusal)).toBeUndefined();
    } finally {
      release();
      consumer.release();
      await instance.dispose();
    }
  },
);

it("does not redirect a captured refusal to a later operation on the same instance", async ({
  signal,
}) => {
  const instance = new PluginInstance("same-instance");
  const consumer = instance.retainConsumer();
  const firstTail = createDeferred<PluginReplacementOutcome>();
  const nextTail = createDeferred<PluginReplacementOutcome>();
  const first = { operationId: "first", settled: firstTail.promise };
  const next = { operationId: "next", settled: nextTail.promise };
  const releaseFirst = instance.reserveReplacement(first);
  let releaseNext = () => {};
  try {
    const refusal = captureThrown(
      () => consumer.run(() => assertPreparedModelRuntimeAdmissionCanWait()),
      "Expected the first operation to block its consumer",
    );
    const captured = readPreparedRuntimeSelfHold(refusal);
    expect(captured?.held[0]?.operation).toBe(first);
    releaseFirst();
    releaseNext = instance.reserveReplacement(next);
    const later = captureThrown(
      () => consumer.run(() => assertPreparedModelRuntimeAdmissionCanWait()),
      "Expected the later operation to block its consumer",
    );
    expect(readPreparedRuntimeSelfHold(later)?.held[0]?.operation).toBe(next);
    expect(readPreparedRuntimeSelfHold(refusal)?.held[0]?.operation).toBe(first);
    // Completing a later reload cannot turn the first reload's failure into success.
    nextTail.resolve({ kind: "applied", committed: true, unavailablePluginIds: [] });
    firstTail.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
    expect(captured).toBeDefined();
    await expect(withinTest(captured!.held[0]!.operation.settled, signal)).resolves.toMatchObject({
      kind: "failed",
      committed: false,
    });
  } finally {
    releaseFirst();
    releaseNext();
    consumer.release();
    firstTail.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
    nextTail.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
    await Promise.all([firstTail.promise, nextTail.promise, instance.dispose()]);
  }
});
