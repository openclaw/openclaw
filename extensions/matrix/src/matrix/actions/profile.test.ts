import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.fn();
const syncMatrixOwnProfileMock = vi.fn<typeof import("../profile.js").syncMatrixOwnProfile>();
const withClientMock = vi.fn();

// mock-isolation: avatar loader assertions use fixture media I/O, not a live Matrix runtime.
vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    media: { loadWebMedia: loadWebMediaMock },
  }),
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: syncMatrixOwnProfileMock,
}));

// mock-isolation: profile actions use the fixture client without creating a Matrix connection.
vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withClientMock(...args),
}));

const { updateMatrixOwnProfile } = await import("./profile.js");

describe("matrix profile actions", () => {
  const actionClient = { getUserId: vi.fn(async () => "@bot:example.org") };
  beforeEach(() => {
    vi.clearAllMocks();
    withClientMock.mockImplementation(async (_opts, run) => run(actionClient));
  });

  it("trims profile fields and persists through the action client wrapper", async () => {
    const opts = {
      accountId: "ops",
      displayName: "  Ops Bot  ",
      avatarUrl: "  mxc://example/avatar  ",
      avatarPath: "  /tmp/avatar.png  ",
    };
    await updateMatrixOwnProfile({ ...opts });
    expect(withClientMock).toHaveBeenCalledExactlyOnceWith(opts, expect.any(Function));
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
