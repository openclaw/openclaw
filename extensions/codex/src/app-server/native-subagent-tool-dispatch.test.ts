import { expect, it, vi } from "vitest";
import {
  createNativeModelSourceFixture,
  createMonitorFixture,
  notifyChildStarted,
} from "./native-subagent-monitor.test-support.js";
import type { NativeChildDynamicToolExecutor } from "./native-subagent-tool-dispatch.js";

const call = {
  method: "item/tool/call",
  id: 1,
  params: {
    threadId: "child-thread",
    turnId: "child-turn",
    callId: "call",
    tool: "search_notes",
    namespace: "openclaw",
    arguments: {},
  },
};

it("executes only the admitted direct turn, once, including after its parent unregisters", async () => {
  const { client, monitor } = createMonitorFixture();
  const result = { contentItems: [], success: true };
  const executeDynamicTool = vi.fn(async () => result);
  const release = vi.fn();
  const source = createNativeModelSourceFixture(["model"]);
  const owner = await monitor.registerParent({
    retainDynamicToolPolicy: () => release,
    parentThreadId: "parent-thread",
    modelSource: source,
    executeDynamicTool,
  });
  owner.bindTurn("parent-turn");
  await notifyChildStarted(client);
  await client.startTurn("child-turn");
  // Thread lineage without an admitted spawn receipt is not a capability.
  expect(await client.handleServerRequest(call)).toBeUndefined();
  await client.spawn();
  await owner.unregister();
  expect(release).not.toHaveBeenCalled();
  await notifyChildStarted(client, "child-thread", "nested");
  await client.spawn("nested", "child-turn", "v2", "child-thread");
  await client.startTurn("nested-turn", { threadId: "nested" });
  for (const params of [
    { threadId: "stranger" },
    { threadId: "nested", turnId: "nested-turn" },
    { turnId: "old-turn" },
    { threadId: "parent-thread" },
  ]) {
    expect(
      await client.handleServerRequest({ ...call, params: { ...call.params, ...params } }),
    ).toBeUndefined();
  }
  expect(executeDynamicTool).not.toHaveBeenCalled();
  const responses = await Promise.all([
    client.handleServerRequest(call),
    client.handleServerRequest({ ...call, id: 2 }),
  ]);
  expect(responses).toEqual([result, result]);
  expect(executeDynamicTool).toHaveBeenCalledTimes(1);
  vi.spyOn(source, "assertCurrent").mockImplementation(() => {
    throw new Error("source revoked");
  });
  await expect(client.handleServerRequest(call)).rejects.toThrow("source revoked");
  await monitor.retireParent("parent-thread");
  expect(release).toHaveBeenCalledTimes(1);
  expect(await client.handleServerRequest(call)).toBeUndefined();
  expect(executeDynamicTool).toHaveBeenCalledTimes(1);
});

it("aborts admitted work on interruption and will not accept another call on the interrupted turn", async () => {
  const { client, monitor } = createMonitorFixture();
  const entered = Promise.withResolvers<void>();
  const executeDynamicTool = vi.fn<NativeChildDynamicToolExecutor>(async ({ signal }) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { contentItems: [], success: false };
  });
  const owner = await monitor.registerParent({
    parentThreadId: "parent-thread",
    modelSource: createNativeModelSourceFixture(["model"]),
    executeDynamicTool,
  });
  owner.bindTurn("parent-turn");
  await notifyChildStarted(client);
  await client.spawn();
  await client.startTurn("child-turn");
  const pending = client.handleServerRequest(call);
  await entered.promise;
  await client.completeTurn({ turnId: "child-turn", status: "interrupted" });
  expect(await pending).toEqual({ contentItems: [], success: false });
  expect(await client.handleServerRequest(call)).toBeUndefined();
  expect(executeDynamicTool).toHaveBeenCalledTimes(1);
  await owner.unregister();
});
