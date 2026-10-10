// Matrix tests cover profile plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.fn();
const syncMatrixOwnProfileMock = vi.fn<typeof import("../profile.js").syncMatrixOwnProfile>();
const withResolvedActionClientMock = vi.fn();

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    media: {
      loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
    },
  }),
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: syncMatrixOwnProfileMock,
}));

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
}));

const { updateMatrixOwnProfile } = await import("./profile.js");

describe("matrix profile actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("avatar"),
      contentType: "image/png",
      fileName: "avatar.png",
    });
    syncMatrixOwnProfileMock.mockResolvedValue({
      skipped: false,
      displayNameUpdated: true,
      avatarUpdated: true,
      resolvedAvatarUrl: "mxc://example/avatar",
      convertedAvatarFromHttp: true,
      uploadedAvatarSource: "http",
    });
  });

  it("trims profile fields and persists through the action client wrapper", async () => {
    const actionClient = {
      getUserId: vi.fn(async () => "@bot:example.org"),
    };
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run(actionClient);
    });

    await updateMatrixOwnProfile({
      accountId: "ops",
      displayName: "  Ops Bot  ",
      avatarUrl: "  mxc://example/avatar  ",
      avatarPath: "  /tmp/avatar.png  ",
    });

    expect(withResolvedActionClientMock).toHaveBeenCalledExactlyOnceWith(
      {
        accountId: "ops",
        displayName: "  Ops Bot  ",
        avatarUrl: "  mxc://example/avatar  ",
        avatarPath: "  /tmp/avatar.png  ",
      },
      expect.any(Function),
      "persist",
    );
    expect(syncMatrixOwnProfileMock).toHaveBeenCalledExactlyOnceWith({
      client: actionClient,
      userId: "@bot:example.org",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      avatarPath: "/tmp/avatar.png",
      loadAvatarFromUrl: expect.any(Function),
      loadAvatarFromPath: expect.any(Function),
    });
    expect(syncMatrixOwnProfileMock.mock.calls[0]?.[0].client).toBe(actionClient);
  });

  it("bridges avatar loaders through Matrix runtime media helpers", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        getUserId: vi.fn(async () => "@bot:example.org"),
      });
    });

    await updateMatrixOwnProfile({
      avatarUrl: "https://cdn.example.org/avatar.png",
      avatarPath: "/tmp/avatar.png",
    });

    const call = syncMatrixOwnProfileMock.mock.calls[0]?.[0];

    if (!call?.loadAvatarFromUrl || !call.loadAvatarFromPath) {
      throw new Error("Expected profile avatar loaders");
    }

    await call.loadAvatarFromUrl("https://cdn.example.org/avatar.png", 123);
    await call.loadAvatarFromPath("/tmp/avatar.png", 456);

    expect(loadWebMediaMock).toHaveBeenNthCalledWith(1, "https://cdn.example.org/avatar.png", 123);
    expect(loadWebMediaMock).toHaveBeenNthCalledWith(2, "/tmp/avatar.png", {
      maxBytes: 456,
      localRoots: undefined,
    });
  });
});
