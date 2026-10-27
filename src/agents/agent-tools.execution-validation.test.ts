import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import {
  runWithToolExecutionValidation,
  validateToolExecutionParams,
} from "./agent-tools.execution-validation.js";

it.each([false, true])(
  "releases validators from settled async frames (reject=%s)",
  async (reject) => {
    async function completeInvocation() {
      const validator = vi.fn();
      const reference = new WeakRef(validator);
      let retainedFrame: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
      const operation = runWithToolExecutionValidation("finished", validator, async () => {
        retainedFrame = AsyncLocalStorage.snapshot();
        await validateToolExecutionParams("finished", { input: "live" });
        expect(validator).toHaveBeenCalledWith({ input: "live" });
        if (reject) {
          throw new Error("tool failed");
        }
      });
      if (reject) {
        await expect(operation).rejects.toThrow("tool failed");
      } else {
        await operation;
      }
      return { reference, retainedFrame: retainedFrame! };
    }
    const completed = await Promise.all(Array.from({ length: 20 }, completeInvocation));
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(completed.filter(({ reference }) => reference.deref())).toHaveLength(0);
    // Retiring the closure must not turn an inherited validation scope into a bypass.
    await expect(
      completed[0]!.retainedFrame(() => validateToolExecutionParams("finished", {})),
    ).rejects.toThrow("Tool execution validation scope is closed");
  },
);

it("isolates concurrent and nested validators until their own execution settles", async () => {
  const calls: string[] = [];
  await Promise.all(
    ["left", "right"].map((id) =>
      runWithToolExecutionValidation(
        id,
        () => {
          calls.push(id);
        },
        async () => {
          await nextTurn();
          await validateToolExecutionParams(id, {});
          await runWithToolExecutionValidation(
            "nested",
            () => {
              calls.push(`${id}:nested`);
            },
            async () => {
              await validateToolExecutionParams("nested", {});
            },
          );
          await validateToolExecutionParams(id, {});
          await validateToolExecutionParams("unrelated", {});
        },
      ),
    ),
  );
  expect(calls.filter((value) => value === "left")).toHaveLength(2);
  expect(calls.filter((value) => value === "right")).toHaveLength(2);
  expect(calls.filter((value) => value.endsWith(":nested"))).toHaveLength(2);
});
