import { afterEach, expect, it, vi } from "vitest";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { withCodexSessionDescendantCancellation } from "./session-cancellation.js";

afterEach(() => vi.restoreAllMocks());

it("reports an unavailable cancellation binding reader without claiming descendants stopped", async () => {
  const bindingStore = createCodexTestBindingStore();
  const session = {
    kind: "session" as const,
    agentId: "main",
    sessionKey: "agent:main:unavailable-cancellation",
    sessionId: "unavailable-cancellation-session",
  };
  await bindingStore.mutate(session, {
    kind: "set",
    binding: { threadId: "owned-thread", clientId: "owned-client", cwd: "/repo" },
  });
  vi.spyOn(bindingStore, "prepareRead").mockResolvedValueOnce(undefined);
  const signalParent = vi.fn(async () => "stopped");

  await expect(
    withCodexSessionDescendantCancellation(
      bindingStore,
      { ...session, assertCurrent: () => {}, acceptsRequest: () => true },
      signalParent,
    ),
  ).rejects.toThrow("Codex descendant cancellation binding reader is unavailable");
  expect(signalParent).not.toHaveBeenCalled();
  expect(bindingStore.read(session)?.threadId).toBe("owned-thread");
});
