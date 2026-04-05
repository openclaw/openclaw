import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

const addMattermostReaction = vi.hoisted(() => vi.fn());
const removeMattermostReaction = vi.hoisted(() => vi.fn());

vi.mock("./reactions.js", () => ({
  addMattermostReaction,
  removeMattermostReaction,
}));

function createConfig(): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        botToken: "bot-token",
        baseUrl: "https://chat.example.com",
      },
    },
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("mattermost transient inbound reactions", () => {
  beforeEach(() => {
    vi.resetModules();
    addMattermostReaction.mockReset();
    removeMattermostReaction.mockReset();
    addMattermostReaction.mockResolvedValue({ ok: true });
    removeMattermostReaction.mockResolvedValue({ ok: true });
  });

  it("adds :eyes: before dispatch and removes it after dispatch settles", async () => {
    const dispatch = vi.fn(async () => {});
    const runtime = createRuntime();
    const { runMattermostTransientInboundReactionLifecycle } = await import("./monitor.js");

    await runMattermostTransientInboundReactionLifecycle({
      cfg: createConfig(),
      runtime,
      accountId: "default",
      postId: "post-1",
      runDispatch: dispatch,
    });

    expect(addMattermostReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: "post-1",
        emojiName: "eyes",
        accountId: "default",
      }),
    );
    expect(removeMattermostReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: "post-1",
        emojiName: "eyes",
        accountId: "default",
      }),
    );

    const addOrder = addMattermostReaction.mock.invocationCallOrder[0];
    const dispatchOrder = dispatch.mock.invocationCallOrder[0];
    const removeOrder = removeMattermostReaction.mock.invocationCallOrder[0];
    expect(addOrder).toBeLessThan(dispatchOrder);
    expect(dispatchOrder).toBeLessThan(removeOrder);
  });

  it("removes :eyes: even when dispatch throws", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch failed");
    });
    const runtime = createRuntime();
    const { runMattermostTransientInboundReactionLifecycle } = await import("./monitor.js");

    await expect(
      runMattermostTransientInboundReactionLifecycle({
        cfg: createConfig(),
        runtime,
        accountId: "default",
        postId: "post-1",
        runDispatch: dispatch,
      }),
    ).rejects.toThrow("dispatch failed");

    expect(addMattermostReaction).toHaveBeenCalledTimes(1);
    expect(removeMattermostReaction).toHaveBeenCalledTimes(1);
    const dispatchOrder = dispatch.mock.invocationCallOrder[0];
    const removeOrder = removeMattermostReaction.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeLessThan(removeOrder);
  });
});
