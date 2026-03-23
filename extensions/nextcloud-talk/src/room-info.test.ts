import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuard = vi.fn();
const readFileSync = vi.fn();

vi.mock("../runtime-api.js", () => ({
  fetchWithSsrFGuard,
}));

vi.mock("node:fs", () => ({
  readFileSync,
}));

describe("nextcloud talk room info", () => {
  afterEach(() => {
    fetchWithSsrFGuard.mockReset();
    readFileSync.mockReset();
  });

  it("resolves direct rooms from the room info endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          ocs: {
            data: {
              type: 1,
            },
          },
        }),
      },
      release,
    });

    const { resolveNextcloudTalkRoomKind } = await import("./room-info.js");
    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "acct-direct",
        baseUrl: "https://nc.example.com",
        config: {
          apiUser: "bot",
          apiPassword: "secret",
        },
      } as never,
      roomToken: "room-direct",
    });

    expect(kind).toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-direct",
        auditContext: "nextcloud-talk.room-info",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads the api password from a file and logs non-ok responses", async () => {
    const release = vi.fn(async () => {});
    const log = vi.fn();
    readFileSync.mockReturnValue("file-secret\n");
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 403,
        json: async () => ({}),
      },
      release,
    });

    const { resolveNextcloudTalkRoomKind } = await import("./room-info.js");
    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "acct-group",
        baseUrl: "https://nc.example.com",
        config: {
          apiUser: "bot",
          apiPasswordFile: "/tmp/nextcloud-secret",
        },
      } as never,
      roomToken: "room-group",
      runtime: { log },
    });

    expect(kind).toBeUndefined();
    expect(readFileSync).toHaveBeenCalledWith("/tmp/nextcloud-secret", "utf-8");
    expect(log).toHaveBeenCalledWith(
      "nextcloud-talk: room lookup failed (403) token=room-group",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined without credentials or base url", async () => {
    const { resolveNextcloudTalkRoomKind } = await import("./room-info.js");

    await expect(
      resolveNextcloudTalkRoomKind({
        account: {
          accountId: "acct-missing",
          baseUrl: "",
          config: {},
        } as never,
        roomToken: "room-missing",
      }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
