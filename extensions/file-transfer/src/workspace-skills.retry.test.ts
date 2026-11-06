import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNodeWorkspaceSkills } from "./workspace-skills.js";
import type { NodeWorkspaceWorkerOptions } from "./workspace-worker.js";

const unavailable = (details: unknown) =>
  Object.assign(new Error("node unavailable"), { code: "UNAVAILABLE", details });
// The workspace.skills policy forwards the node failure without marking it unavailable.
const disconnected = () =>
  Object.assign(new Error("node disconnected (workspace.skills)"), {
    code: "INVALID_REQUEST",
    details: {
      code: "DISCONNECTED",
      nodeError: { code: "DISCONNECTED" },
      nodeCommandDispatched: true,
    },
  });
const notConnected = () =>
  unavailable({
    code: "NOT_CONNECTED",
    nodeError: { code: "NOT_CONNECTED" },
    nodeCommandDispatched: false,
  });

function reader(openDuplex: NodeWorkspaceWorkerOptions["openDuplex"], signal?: AbortSignal) {
  return createNodeWorkspaceSkills({
    nodeId: "node-1",
    workspaceDir: "/gateway/workspace",
    remoteRoot: "/node/workspace",
    signal: signal ?? new AbortController().signal,
    openDuplex,
  }).skillResources;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// These are external failure envelopes, not a replacement connection or a fabricated success.
it.each([disconnected, notConnected])("bounds offline read retries for %s", async (failure) => {
  const error = failure();
  const open = vi.fn<NodeWorkspaceWorkerOptions["openDuplex"]>(async () => {
    throw error;
  });
  const result = reader(open).readInstructions("/node/workspace/skills/tool/SKILL.md", {});
  const failed = expect(result).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await failed;
  expect(open).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  Object.assign(new Error("command denied"), { code: "INVALID_REQUEST" }),
  unavailable({ nodeError: { code: "PERMISSION_DENIED" } }),
  unavailable({ nodeError: { code: "POLICY_CHANGED" } }),
  unavailable({ nodeError: { code: "TIMEOUT" } }),
  unavailable({}),
  Object.assign(new Error("workspace policy denied"), {
    code: "INVALID_REQUEST",
    details: { code: "POLICY_DENIED", nodeCommandDispatched: false },
  }),
  ...[undefined, false].map((nodeCommandDispatched) =>
    Object.assign(disconnected(), {
      details: { ...disconnected().details, nodeCommandDispatched },
    }),
  ),
  Object.assign(disconnected(), {
    details: { ...disconnected().details, code: "POLICY_DENIED" },
  }),
  unavailable(disconnected().details),
  unavailable({
    code: "NOT_CONNECTED",
    nodeError: { code: "NOT_CONNECTED" },
    nodeCommandDispatched: true,
  }),
])("does not redispatch a terminal read refusal: %s", async (error) => {
  const open = vi.fn<NodeWorkspaceWorkerOptions["openDuplex"]>(async () => {
    throw error;
  });
  await expect(
    reader(open).readInstructions("/node/workspace/skills/tool/SKILL.md", {}),
  ).rejects.toBe(error);
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["caller", "binding"])("cancels a read backoff when its %s ends", async (owner) => {
  const controller = new AbortController();
  const open = vi.fn<NodeWorkspaceWorkerOptions["openDuplex"]>(async () => {
    throw disconnected();
  });
  const resources = reader(open, owner === "binding" ? controller.signal : undefined);
  const result = resources.readInstructions("/node/workspace/skills/tool/SKILL.md", {
    signal: owner === "caller" ? controller.signal : undefined,
  });
  const failed = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("read owner stopped"));
  await failed;
  await vi.runAllTimersAsync();
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps one read deadline across connection attempts", async () => {
  let calls = 0;
  const open = vi.fn<NodeWorkspaceWorkerOptions["openDuplex"]>(
    async ({ signal }) =>
      await new Promise<never>((_resolve, reject) => {
        if (++calls === 1) {
          setTimeout(() => reject(disconnected()), 50_000);
          return;
        }
        // An active transport honors the caller's abort; it does not invent its own timeout.
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  const result = reader(open).readInstructions("/node/workspace/skills/tool/SKILL.md", {});
  const failed = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(open).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});
