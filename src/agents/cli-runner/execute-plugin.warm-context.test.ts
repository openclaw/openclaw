import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

afterEach(() => {
  closePluginTestAdmissions();
});

describe("plugin-owned CLI warm transport callbacks", () => {
  it("runs host assertions in the current turn's async context, not the first turn's", async () => {
    const turnScope = new AsyncLocalStorage<string>();
    // A warm transport's reader is created by the first turn and keeps that turn's
    // async context for every callback it makes during later turns.
    let fromWarmTransport: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;

    const runTurn = async (label: string) => {
      const { context } = await createExecution();
      const observed: Array<string | undefined> = [];
      context.params.assertCurrent = () => {
        observed.push(turnScope.getStore());
      };
      let seenFromTransport: Array<string | undefined> = [];
      await turnScope.run(label, () =>
        runPlugin(context, async function* (execution) {
          fromWarmTransport ??= AsyncLocalStorage.snapshot();
          observed.length = 0;
          fromWarmTransport(() => execution.assertCurrent?.());
          seenFromTransport = [...new Set(observed)];
          yield SUCCESS_RESULT;
        }),
      );
      return seenFromTransport;
    };

    expect(await runTurn("turn-1")).toEqual(["turn-1"]);
    expect(await runTurn("turn-2")).toEqual(["turn-2"]);
  });
});
