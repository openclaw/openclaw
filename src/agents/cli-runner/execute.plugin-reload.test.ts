import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { PluginInstanceDrainTimeoutError } from "../../plugins/plugin-instance-error.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import {
  closePluginTestAdmissions,
  createExecution,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { retainCliPluginExecutionConsumer } from "./execution-target.js";

afterEach(() => {
  vi.useRealTimers();
  closePluginTestAdmissions();
});

it("delivers a turn that outlives its backend instance's retirement", async ({ signal }) => {
  // Regression #144809: a retained CLI turn and its cleanup outlive plugin retirement.
  const owner = new PluginInstance("anthropic");
  const finish = createDeferred();
  const started = createDeferred();
  const execute = owner.wrap<CliBackendExecute>(async function* () {
    yield { type: "system", subtype: "init", session_id: "sdk-session" };
    started.resolve();
    await finish.promise;
    yield SUCCESS_RESULT;
  });
  const cleaned = vi.fn(async () => {});
  const cleanup = owner.wrap(cleaned);
  const { context, admission } = await createExecution({ config: {}, timeoutMs: 120_000 });
  context.preparedBackend.backend.jsonlDialect = "claude-stream-json";
  context.backendResolved.bundleMcp = false;
  context.executionTarget = { kind: "plugin", execute };
  context.pluginExecutionConsumer = retainCliPluginExecutionConsumer(execute);
  const consumer = context.pluginExecutionConsumer;
  expect(consumer).toBeDefined();
  let outcome: { ok: true; text: string } | { ok: false; error: unknown } | undefined;
  const run = executePreparedCliRun(context).then(
    (value) => {
      outcome = { ok: true, text: value.text };
    },
    (error: unknown) => {
      outcome = { ok: false, error };
    },
  );
  let disposal: ReturnType<typeof owner.dispose> | undefined;
  let settlement: Promise<void> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(started.promise, run, "CLI turn settled before its stream started"),
      signal,
    );

    vi.useFakeTimers({ shouldClearNativeTimers: true });
    disposal = owner.dispose();
    await vi.advanceTimersByTimeAsync(5_001);
    const timeout = (await disposal).errors[0];
    expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
    if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
      throw new Error("Expected bounded retirement while the CLI consumer is retained");
    }
    settlement = timeout.settled;
    expect(timeout.forcedRetirement?.retainedConsumerCount).toBe(1);
    expect(owner.acceptingCalls).toBe(false);
    finish.resolve();

    // Settle under fake timers so a regression fails on its own error instead of hanging.
    await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 30_000, interval: 100 });
    expect(outcome, "CLI run did not settle after its plugin instance retired").toEqual({
      ok: true,
      text: "completed",
    });
    // Prepared cleanup runs inside the same retained scope before releasing it.
    await consumer!.run(cleanup);
    expect(cleaned).toHaveBeenCalledOnce();
    consumer!.release();
    expect(() => consumer!.run(cleanup)).toThrow("consumer is closed");
    await settlement;
  } finally {
    // A failed assertion must not strand the iterator or its retained owner.
    finish.resolve();
    consumer?.release();
    admission.close();
    await Promise.allSettled([run, disposal ?? owner.dispose(), settlement]);
  }
});
