import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

const { matrixMessageActions } = await import("./actions.js");

function createContext(
  overrides: Partial<ChannelMessageActionContext>,
): ChannelMessageActionContext {
  return {
    channel: "matrix",
    action: "send",
    cfg: {
      channels: {
        matrix: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "token",
        },
      },
    } as CoreConfig,
    params: {},
    ...overrides,
  };
}

describe("matrixMessageActions account propagation", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockReset().mockResolvedValue({
      ok: true,
      output: "",
      details: { ok: true },
    });
  });

  it("forwards accountId for send actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        params: {
          to: "room:!room:example",
          message: "hello",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        accountId: "ops",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards accountId for permissions actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "permissions",
        accountId: "ops",
        params: {
          operation: "verification-list",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "verificationList",
        accountId: "ops",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards accountId for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "set-profile",
        accountId: "ops",
        params: {
          displayName: "Ops Bot",
          avatarUrl: "mxc://example/avatar",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setProfile",
        accountId: "ops",
        displayName: "Ops Bot",
        avatarUrl: "mxc://example/avatar",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards local avatar paths for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "set-profile",
        accountId: "ops",
        params: {
          path: "/tmp/avatar.jpg",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setProfile",
        accountId: "ops",
        avatarPath: "/tmp/avatar.jpg",
      }),
      expect.any(Object),
      { mediaLocalRoots: undefined },
    );
  });

  it("forwards mediaLocalRoots for media sends", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        params: {
          to: "room:!room:example",
          message: "hello",
          media: "file:///tmp/photo.png",
        },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        accountId: "ops",
        mediaUrl: "file:///tmp/photo.png",
      }),
      expect.any(Object),
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );
  });
});
