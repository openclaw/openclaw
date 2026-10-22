import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.fn();
const withClientMock = vi.fn();

// mock-isolation: avatar loader assertions use fixture media I/O, not a live Matrix runtime.
vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    media: { loadWebMedia: loadWebMediaMock },
  }),
}));

// mock-isolation: profile actions use the fixture client without creating a Matrix connection.
vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withClientMock(...args),
}));

const { updateMatrixOwnProfile } = await import("./profile.js");

describe("matrix profile actions", () => {
  const actionClient = {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getUserProfile: vi.fn(async () => ({})),
    setDisplayName: vi.fn(async () => {}),
    setAvatarUrl: vi.fn(async () => {}),
    uploadContent: vi.fn(async () => "mxc://example/uploaded-avatar"),
  };
  const media = { buffer: Buffer.from("avatar"), contentType: "image/png", fileName: "avatar.png" };
  beforeEach(() => {
    vi.clearAllMocks();
    withClientMock.mockImplementation(async (_opts, run) => run(actionClient));
    loadWebMediaMock.mockResolvedValue(media);
  });

  it("trims profile fields and persists through the action client wrapper", async () => {
    const opts = {
      accountId: "ops",
      displayName: "  Ops Bot  ",
      avatarUrl: "  mxc://example/avatar  ",
      avatarPath: "  /tmp/avatar.png  ",
    };
    const result = await updateMatrixOwnProfile({ ...opts });
    expect(withClientMock).toHaveBeenCalledExactlyOnceWith(opts, expect.any(Function));
    expect(actionClient.getUserProfile).toHaveBeenCalledExactlyOnceWith("@bot:example.org");
    expect(actionClient.setDisplayName).toHaveBeenCalledExactlyOnceWith("Ops Bot");
    expect(loadWebMediaMock).toHaveBeenCalledExactlyOnceWith("/tmp/avatar.png", {
      maxBytes: 10 * 1024 * 1024,
      localRoots: undefined,
    });
    expect(actionClient.uploadContent).toHaveBeenCalledExactlyOnceWith(
      media.buffer,
      media.contentType,
      media.fileName,
    );
    expect(actionClient.setAvatarUrl).toHaveBeenCalledExactlyOnceWith(
      "mxc://example/uploaded-avatar",
    );
    expect(result).toMatchObject({ displayNameUpdated: true, avatarUpdated: true });
  });

  it.each(["http", "path"])(
    "bridges the %s avatar loader through runtime media helpers",
    async (source) => {
      await updateMatrixOwnProfile({
        ...(source === "http"
          ? { avatarUrl: "  https://cdn.example.org/avatar.png  " }
          : { avatarPath: "  /tmp/avatar.png  " }),
        mediaLocalRoots: ["/tmp"],
      });
      expect(loadWebMediaMock).toHaveBeenCalledExactlyOnceWith(
        source === "http" ? "https://cdn.example.org/avatar.png" : "/tmp/avatar.png",
        source === "http" ? 10 * 1024 * 1024 : { maxBytes: 10 * 1024 * 1024, localRoots: ["/tmp"] },
      );
      expect(actionClient.setAvatarUrl).toHaveBeenCalledExactlyOnceWith(
        "mxc://example/uploaded-avatar",
      );
    },
  );

  it("skips blank desired profile values before provider or media effects", async () => {
    expect(
      await updateMatrixOwnProfile({ displayName: "  ", avatarUrl: "\t", avatarPath: "\n" }),
    ).toMatchObject({ skipped: true, displayNameUpdated: false, avatarUpdated: false });
    expect(actionClient.getUserProfile).not.toHaveBeenCalled();
    expect(actionClient.setDisplayName).not.toHaveBeenCalled();
    expect(actionClient.setAvatarUrl).not.toHaveBeenCalled();
    expect(actionClient.uploadContent).not.toHaveBeenCalled();
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });
});
