import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

const observed = vi.hoisted(() => ({
  imports: 0,
  defer: false,
  started: Promise.withResolvers<void>(),
  released: Promise.withResolvers<void>(),
  recall: vi.fn(),
}));

vi.mock("./recall.js", async () => {
  observed.imports += 1;
  observed.started.resolve();
  if (observed.defer) {
    await observed.released.promise;
  }
  return { maybeResolveActiveRecall: observed.recall };
});

it("bounds cold loading by preflight and rechecks each caller before resuming", async () => {
  expect(observed.imports).toBe(0);
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const current = vi.fn(() => ({}));
  const warn = vi.fn();
  const api = createTestPluginApi({
    id: "active-memory",
    on,
    logger: { info() {}, warn, error() {}, debug() {} },
    runtime: { config: { current } } as unknown as OpenClawPluginApi["runtime"],
  });
  plugin.register(api);
  expect(on.mock.calls.map(([name]) => name)).toEqual(["before_prompt_build", "agent_end"]);
  const registration = on.mock.calls.find(([name]) => name === "before_prompt_build");
  if (!registration) {
    throw new Error("expected prompt hook registration");
  }
  const hook = registration[1] as Parameters<typeof api.on<"before_prompt_build">>[1];
  expect(registration[2]).toEqual(expect.objectContaining({ requiresToolAuthority: true }));
  expect(observed.imports).toBe(0);
  await expect(hook({ prompt: "hello", messages: [] }, {})).resolves.toBeUndefined();
  expect(observed.imports).toBe(0);
  current.mockClear();

  observed.defer = true;
  let active = true;
  const reason = new Error("turn authority expired");
  const assertActive = vi.fn(() => {
    if (!active) {
      throw reason;
    }
  });
  const context = {
    toolAuthority: { fingerprint: "test-authority", allows: () => true, assertActive },
  };
  const invocationReason = new Error("hook invocation expired");
  const assertInvocationActive = vi.fn(() => {
    if (!active) {
      throw invocationReason;
    }
  });
  const assertSiblingAuthorityActive = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending: Array<Promise<unknown>> = [];
  try {
    const timedOut = Promise.resolve(
      hook(
        { prompt: "cold start", messages: [] },
        { toolAuthority: { ...context.toolAuthority, assertActive() {} } },
      ),
    );
    pending.push(timedOut);
    await observed.started.promise;
    expect(observed.imports).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    const first = Promise.resolve(hook({ prompt: "first", messages: [] }, context));
    const second = Promise.resolve(
      hook(
        { prompt: "second", messages: [] },
        {
          toolAuthority: { ...context.toolAuthority, assertActive: assertSiblingAuthorityActive },
          hookInvocation: { assertActive: assertInvocationActive },
        },
      ),
    );
    pending.push(first, second);
    expect(assertActive).toHaveBeenCalledTimes(1);
    expect(assertSiblingAuthorityActive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(timedOut).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("preflight timed out"));
    expect(current).not.toHaveBeenCalled();
    active = false;
    observed.released.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason.message));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(invocationReason.message));
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(assertSiblingAuthorityActive).toHaveBeenCalledTimes(2);
    expect(assertInvocationActive).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
    expect(observed.recall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    observed.released.resolve();
    await Promise.allSettled(pending);
    vi.useRealTimers();
  }
});
