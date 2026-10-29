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

it("rejects stale waiters without blocking the next eligible root", async () => {
  const { register, root } = await saturatedContext();
  let current = true;
  const rejected = expect(
    register("stale", undefined, () => {
      if (!current) {
        throw new Error("lost owner");
      }
    }),
  ).rejects.toThrow("lost owner");
  const next = register("next");
  current = false;
  root.release();
  await rejected;
  (await next).release();
});

it("replaces the same thread without granting a queued root an extra slot", async () => {
  const { register, root } = await saturatedContext();
  let admitted = false;
  const queued = register("queued").then((value) => {
    admitted = true;
    return value;
  });
  const replacement = await register("root");
  root.release();
  await Promise.resolve();
  expect(admitted).toBe(false);
  replacement.release();
  (await queued).release();
});

it("rechecks the prepared prefix limit at admission and drains the next waiter", async () => {
  const context = createCodexInferenceContext(() => {});
  onTestFinished(() => context.close());
  const register = (threadId: string, retainPrefix = true) =>
    context.register({
      threadId,
      text: "prepared",
      signal: new AbortController().signal,
      assertCurrent() {},
      retainPrefix,
    });
  for (let index = 0; index < 255; index++) {
    (await register(`saved-${index}`)).release();
  }
  const roots = await Promise.all(
    Array.from({ length: 64 }, (_, index) => register(`active-${index}`, false)),
  );
  const rejected = expect(register("overflow")).rejects.toThrow("prepared inference prefix limit");
  const next = register("next", false);
  const last = await register("active-0");
  last.release();
  await rejected;
  (await next).release();
  roots.forEach((root) => root.release());
});

it.each(["abort", "close"])("removes a queued independent fork on %s", async (mode) => {
  const context = createCodexInferenceContext(() => {});
  onTestFinished(() => context.close());
  const parentController = new AbortController();
  const parent = await context.register({
    threadId: "parent",
    text: "prefix",
    signal: parentController.signal,
    assertCurrent() {},
  });
  parent.release();
  parentController.abort();
  const roots = await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      context.register({
        threadId: `active-${index}`,
        text: "",
        signal: new AbortController().signal,
        assertCurrent() {},
        retainPrefix: false,
      }),
    ),
  );
  const childController = new AbortController();
  const child = context.fork({
    sourceThreadId: "parent",
    threadId: "child",
    signal: childController.signal,
    assertCurrent() {},
  });
  const rejected = expect(child).rejects.toThrow(
    mode === "abort" ? "child cancelled" : "transport is closed",
  );
  if (mode === "abort") {
    childController.abort(new Error("child cancelled"));
  } else {
    context.close();
  }
  await rejected;
  roots.forEach((root) => root.release());
});

it("normalizes a non-Error cancellation reason", async () => {
  const { register } = await saturatedContext();
  const controller = new AbortController();
  const rejected = expect(register("cancelled", controller.signal)).rejects.toBeInstanceOf(Error);
  controller.abort("cancelled without an Error object");
  await rejected;
});
