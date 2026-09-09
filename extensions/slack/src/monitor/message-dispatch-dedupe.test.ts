// Slack message-dispatch dedupe observability tests.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  claimSlackMessageDispatchReplay,
  type SlackMessageDispatchReplayGuard,
} from "./message-dispatch-dedupe.js";

function createIngressObserver() {
  const finish = vi.fn();
  return {
    stage: vi.fn(),
    progress: vi.fn(),
    correlate: vi.fn(),
    begin: vi.fn(() => ({ finish })),
    finish,
  };
}

describe("claimSlackMessageDispatchReplay", () => {
  it("observes only the actual in-flight owner wait", async () => {
    const ownerPending = createDeferred<boolean>();
    const observer = createIngressObserver();
    const guard = {
      claim: vi.fn(async () => ({ kind: "inflight", pending: ownerPending.promise }) as const),
    } as unknown as SlackMessageDispatchReplayGuard;

    let settled = false;
    const claim = claimSlackMessageDispatchReplay({ guard, key: "k", observer }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(observer.stage).toHaveBeenCalledWith("dedupe_wait", "dedupe_owner");
    expect(observer.begin).toHaveBeenCalledWith({ kind: "dedupe" });

    ownerPending.resolve(true);
    await expect(claim).resolves.toEqual({ kind: "duplicate" });
    expect(observer.finish).toHaveBeenCalledWith("completed");
  });

  it("does not report owner waiting for an immediate claim", async () => {
    const observer = createIngressObserver();
    const handle = {
      keys: ["k"] as readonly [string],
      commit: vi.fn(async () => true),
      release: vi.fn(),
    };
    const guard = {
      claim: vi.fn(async () => ({ kind: "claimed", handle }) as const),
    } as unknown as SlackMessageDispatchReplayGuard;

    await expect(claimSlackMessageDispatchReplay({ guard, key: "k", observer })).resolves.toEqual({
      kind: "claimed",
      handle,
    });

    expect(observer.stage).not.toHaveBeenCalledWith("dedupe_wait", "dedupe_owner");
    expect(observer.begin).not.toHaveBeenCalled();
  });
});
