import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { prepareForegroundTestAdmission } from "../run-execution-policy.test-support.js";
import { acquireForegroundSandboxCustody } from "./foreground-owner.js";

function prepare(runId: string, release = vi.fn()) {
  return prepareForegroundTestAdmission(
    runId,
    createAdmittedRunOperatorAuthority({
      profileId: "requester",
      scopes: ["operator.sessions.write"],
      assertCurrent() {},
      retain: () => release,
    }),
  );
}

describe("foreground allocation owner", () => {
  it.each([false, true])(
    "joins allocation and native retirement before source release (Stop=%s)",
    async (stop) => {
      const release = vi.fn();
      const prepared = prepare(`foreground-${stop}`, release);
      const context = await prepared.admit("embedded");
      const signal = new AbortController();
      const custody = acquireForegroundSandboxCustody(context, signal.signal);
      const started = createDeferred();
      const allocated = createDeferred();
      const retiring = createDeferred();
      const retired = createDeferred();
      let allocationPresent = false;
      custody.registerCleanup(async () => {
        expect(allocationPresent).toBe(true);
        retiring.resolve();
        await retired.promise;
        allocationPresent = false;
      });
      const producer = custody.runProducer(
        async () => {
          started.resolve();
          await allocated.promise;
          allocationPresent = true;
        },
        { settleAfterAbort: true },
      );
      await started.promise;
      if (stop) {
        signal.abort();
      }
      const closing = prepared.close();
      let completed = false;
      void closing.then(() => {
        completed = true;
      });
      expect(custody.signal.aborted).toBe(true);
      expect(() => custody.assertCurrent()).toThrow();
      expect(release).not.toHaveBeenCalled();
      allocated.resolve();
      await producer;
      await retiring.promise;
      expect(completed).toBe(false);
      expect(release).not.toHaveBeenCalled();
      retired.resolve();
      await closing;
      expect(allocationPresent).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("rejects custody and new cleanup registration after admission closes", async () => {
    const prepared = prepare("closed-foreground");
    const context = await prepared.admit("embedded");
    const custody = acquireForegroundSandboxCustody(context);
    await prepared.close();
    expect(() => acquireForegroundSandboxCustody(context)).toThrow();
    expect(() => custody.registerCleanup(async () => {})).toThrow();
    expect(() => custody.runProducer(async () => {})).toThrow();
  });

  it("joins sibling retirement and preserves uncertainty when a native cleanup fails", async () => {
    const prepared = prepare("uncertain-foreground");
    const context = await prepared.admit("embedded");
    const custody = acquireForegroundSandboxCustody(context);
    const pending = createDeferred();
    const started = createDeferred();
    custody.registerCleanup(async () => {
      throw new Error("namespace exit unconfirmed");
    });
    custody.registerCleanup(async () => {
      started.resolve();
      await pending.promise;
    });
    const closing = prepared.close();
    const failure = expect(closing).rejects.toThrow("cleanup");
    await started.promise;
    pending.resolve();
    await failure;
    expect(() => custody.assertCleanupConfirmed()).toThrow("unconfirmed");
    expect(prepared.close()).toBe(closing);
  });
});
