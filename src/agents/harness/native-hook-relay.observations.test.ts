import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { invokeNativeHookRelay, registerOwnedNativeHookRelay } from "./native-hook-relay.js";
import { clearNativeHookRelaysForTests } from "./native-hook-relay.test-support.js";

afterEach(clearNativeHookRelaysForTests);

it("drains accepted scoped observations after the hook transport and foreground close", async () => {
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let recorded = false;
  const observe = vi.fn(async (_invocation: unknown, assertCurrent: () => void) => {
    assertCurrent();
    entered.resolve();
    await finish.promise;
    recorded = true;
  });
  const relay = registerOwnedNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    postToolUse: { toolNames: ["multi_agent_v1send_input"], observe },
  });
  expect(relay.shouldRelayEvent("post_tool_use")).toBe(true);
  expect(relay.toolMatcherForEvent("post_tool_use")).toEqual(["multi_agent_v1send_input"]);
  await invokeNativeHookRelay({
    provider: "codex",
    relayId: relay.relayId,
    event: "post_tool_use",
    rawPayload: { tool_name: "Bash" },
  });
  expect(observe).not.toHaveBeenCalled();
  const controller = new AbortController();
  const invocation = invokeNativeHookRelay(
    {
      provider: "codex",
      relayId: relay.relayId,
      event: "post_tool_use",
      rawPayload: { tool_name: "multi_agent_v1send_input" },
    },
    controller.signal,
  );
  const rejected = expect(invocation).rejects.toThrow("Operation aborted");
  try {
    await entered.promise;
    controller.abort(new Error("transport closed"));
    await rejected;
    relay.unregister();
    let drained = false;
    const drain = relay.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(recorded).toBe(false);
    finish.resolve();
    await drain;
    expect(recorded).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    relay.unregister();
    await relay.drain();
  }
});
