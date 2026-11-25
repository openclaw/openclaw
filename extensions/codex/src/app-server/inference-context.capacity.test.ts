import { expect, it, onTestFinished } from "vitest";
import { createCodexInferenceContext } from "./inference-context.js";

async function saturatedContext(assertCurrent = () => {}) {
  const context = createCodexInferenceContext(assertCurrent);
  onTestFinished(() => context.close());
  const register = (threadId: string, signal = new AbortController().signal, current = () => {}) =>
    context.register({ threadId, text: "", signal, assertCurrent: current, retainPrefix: false });
  const root = await register("root");
  await Promise.all(Array.from({ length: 63 }, (_, index) => register(`root-${index}`)));
  return { context, register, root };
}

it("waits at the root limit and admits released slots in FIFO order", async () => {
  const { register, root } = await saturatedContext();
  const admitted: string[] = [];
  const first = register("first").then((registration) => {
    admitted.push("first");
    return registration;
  });
  const second = register("second").then((registration) => {
    admitted.push("second");
    return registration;
  });
  await Promise.resolve();
  expect(admitted).toEqual([]);
  root.release();
  const firstRoot = await first;
  expect(admitted).toEqual(["first"]);
  const third = register("third").then((registration) => {
    admitted.push("third");
    return registration;
  });
  root.release();
  await Promise.resolve();
  expect(admitted).toEqual(["first"]);
  firstRoot.release();
  (await second).release();
  (await third).release();
  expect(admitted).toEqual(["first", "second", "third"]);
});

it("removes an aborted waiter without consuming a released root", async () => {
  const { register, root } = await saturatedContext();
  const controller = new AbortController();
  const cancelled = register("cancelled", controller.signal);
  const rejected = expect(cancelled).rejects.toThrow("cancel queued turn");
  const next = register("next");
  controller.abort(new Error("cancel queued turn"));
  await rejected;
  root.release();
  (await next).release();
});

it("rejects every queued root when the transport closes", async () => {
  const { context, register } = await saturatedContext();
  const first = expect(register("first")).rejects.toThrow("transport is closed");
  const second = expect(register("second")).rejects.toThrow("transport is closed");
  context.close();
  await Promise.all([first, second]);
});

it.each(["transport", "turn"])("rechecks %s ownership after waiting", async (owner) => {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("owner changed");
    }
  };
  const { register, root } = await saturatedContext(
    owner === "transport" ? assertCurrent : undefined,
  );
  const stale = expect(
    register("stale", undefined, owner === "turn" ? assertCurrent : undefined),
  ).rejects.toThrow("owner changed");
  current = false;
  root.release();
  await stale;
});
