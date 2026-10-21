import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";

const fixture = vi.hoisted(() => ({
  source: { actor: { release: vi.fn(async () => {}) } },
}));

// mock-isolation: The fixture supplies an existing actor to prove release timing without acquiring a database actor.
vi.mock("../../../config/sessions/session-actor-storage-binding.js", () => ({
  acquireSessionActorStorage: async () => fixture.source,
  runWithSessionActorStorage: (_source: unknown, run: () => Promise<unknown>) => run(),
}));

afterEach(() => fixture.source.actor.release.mockClear());

it.each(["completed", "cancelled"] as const)(
  "holds the requester actor after queued acceptance until the controller is %s",
  async (outcome) => {
    const settled = createDeferredCore();
    await expect(
      withSubagentSessionSource(
        {
          agentId: "main",
          sessionKey: "agent:main:requester",
          retainedUntil: () => settled.promise,
        },
        async () => "queued",
      ),
    ).resolves.toBe("queued");
    expect(fixture.source.actor.release).not.toHaveBeenCalled();
    if (outcome === "completed") {
      settled.resolve();
    } else {
      settled.reject(new Error("controller cancelled"));
    }
    await settled.promise.catch(() => {});
    expect(fixture.source.actor.release).toHaveBeenCalledOnce();
  },
);

it("releases the requester when preparation ends without controller adoption", async () => {
  await expect(
    withSubagentSessionSource(
      { agentId: "main", sessionKey: "agent:main:requester", retainedUntil: () => undefined },
      async () => "not admitted",
    ),
  ).resolves.toBe("not admitted");
  expect(fixture.source.actor.release).toHaveBeenCalledOnce();
});
