import { describe, expect, it, vi } from "vitest";
import { isSupportedMatrixAvatarSource, syncMatrixOwnProfile } from "./profile.js";

function createClientStub(profile = {}) {
  return {
    getUserProfile: vi.fn(async () => profile),
    setDisplayName: vi.fn(async () => {}),
    setAvatarUrl: vi.fn(async () => {}),
    uploadContent: vi.fn(async () => "mxc://example/avatar"),
  };
}

function syncProfile(params: Omit<Parameters<typeof syncMatrixOwnProfile>[0], "userId">) {
  return syncMatrixOwnProfile({ userId: "@bot:example.org", ...params });
}

const noUpdates = { displayNameUpdated: false, avatarUpdated: false, uploadedAvatarSource: null };
const oldProfile = { displayname: "Bot", avatar_url: "mxc://example/old" };
const avatarMedia = {
  buffer: Buffer.from("avatar-bytes"),
  contentType: "image/png",
  fileName: "avatar.png",
};

describe("matrix profile sync", () => {
  it("skips when no desired profile values are provided", async () => {
    const client = createClientStub();
    expect(await syncProfile({ client })).toMatchObject({ ...noUpdates, skipped: true });
    expect(client.setDisplayName).not.toHaveBeenCalled();
    expect(client.setAvatarUrl).not.toHaveBeenCalled();
  });

  it("updates display name when desired name differs", async () => {
    const client = createClientStub(oldProfile);
    expect(await syncProfile({ client, displayName: "New Name" })).toMatchObject({
      ...noUpdates,
      skipped: false,
      displayNameUpdated: true,
    });
    expect(client.setDisplayName).toHaveBeenCalledWith("New Name");
  });

  it.each([
    ["http", "https://cdn.example.org/avatar.png", "mxc://example/new-avatar"],
    ["path", "/tmp/avatar.jpg", "mxc://example/path-avatar"],
  ] as const)("uploads a %s avatar and updates the profile", async (source, input, uploaded) => {
    const client = createClientStub(oldProfile);
    client.uploadContent.mockResolvedValue(uploaded);
    const loadAvatar = vi.fn(async () => avatarMedia);
    const result = await syncProfile({
      client,
      ...(source === "http"
        ? { avatarUrl: input, loadAvatarFromUrl: loadAvatar }
        : { avatarPath: input, loadAvatarFromPath: loadAvatar }),
    });
    expect(result).toMatchObject({
      convertedAvatarFromHttp: source === "http",
      uploadedAvatarSource: source,
      resolvedAvatarUrl: uploaded,
      avatarUpdated: true,
    });
    expect(loadAvatar).toHaveBeenCalledWith(input, 10 * 1024 * 1024);
    expect(client.setAvatarUrl).toHaveBeenCalledWith(uploaded);
  });

  it("rejects unsupported avatar URL schemes", async () => {
    await expect(
      syncProfile({ client: createClientStub(), avatarUrl: "file:///tmp/avatar.png" }),
    ).rejects.toThrow("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
  });

  it("recognizes supported avatar sources", () => {
    expect(isSupportedMatrixAvatarSource("mxc://example/avatar")).toBe(true);
    expect(isSupportedMatrixAvatarSource("https://example.org/avatar.png")).toBe(true);
    expect(isSupportedMatrixAvatarSource("http://example.org/avatar.png")).toBe(true);
    expect(isSupportedMatrixAvatarSource("ftp://example.org/avatar.png")).toBe(false);
  });
});
