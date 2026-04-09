import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotForWrite = vi.fn();
const writeConfigFile = vi.fn();

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
});

describe("persistRefreshedTwitchTokens", () => {
  let persistRefreshedTwitchTokens: typeof import("./token-writeback.js").persistRefreshedTwitchTokens;

  beforeEach(async () => {
    vi.resetModules();
    ({ persistRefreshedTwitchTokens } = await import("./token-writeback.js"));
    readConfigFileSnapshotForWrite.mockReset();
    writeConfigFile.mockReset();
  });

  it("updates base-level default account tokens when the default account is config-backed", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            twitch: {
              username: "bot",
              channel: "channel",
              clientId: "client-id",
              accessToken: "oauth:old-access",
              refreshToken: "old-refresh",
              expiresIn: 1200,
              obtainmentTimestamp: 100,
            },
          },
        } satisfies OpenClawConfig,
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });

    await persistRefreshedTwitchTokens({
      accountId: "default",
      tokenSource: "config",
      token: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 3600,
        obtainmentTimestamp: 200,
      },
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          twitch: expect.objectContaining({
            accessToken: "oauth:new-access",
            refreshToken: "new-refresh",
            expiresIn: 3600,
            obtainmentTimestamp: 200,
          }),
        },
      }),
      expect.objectContaining({ expectedConfigPath: "/tmp/openclaw.json" }),
    );
  });

  it("updates accounts.default when the default account token lives in accounts", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            twitch: {
              username: "bot",
              channel: "channel",
              clientId: "client-id",
              accounts: {
                default: {
                  accessToken: "oauth:old-access",
                  refreshToken: "old-refresh",
                  expiresIn: 1200,
                  obtainmentTimestamp: 100,
                },
              },
            },
          },
        } satisfies OpenClawConfig,
      },
      writeOptions: {},
    });

    await persistRefreshedTwitchTokens({
      accountId: "default",
      tokenSource: "config",
      token: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 3600,
        obtainmentTimestamp: 200,
      },
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          twitch: expect.objectContaining({
            accounts: {
              default: expect.objectContaining({
                accessToken: "oauth:new-access",
                refreshToken: "new-refresh",
                expiresIn: 3600,
                obtainmentTimestamp: 200,
              }),
            },
          }),
        },
      }),
      expect.any(Object),
    );
  });

  it("updates named account tokens in the accounts map", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            twitch: {
              accounts: {
                alerts: {
                  accessToken: "oauth:old-access",
                  refreshToken: "old-refresh",
                  expiresIn: 1200,
                  obtainmentTimestamp: 100,
                },
              },
            },
          },
        } satisfies OpenClawConfig,
      },
      writeOptions: {},
    });

    await persistRefreshedTwitchTokens({
      accountId: "alerts",
      tokenSource: "config",
      token: {
        accessToken: "oauth:new-access",
        refreshToken: "new-refresh",
        expiresIn: 3600,
        obtainmentTimestamp: 200,
      },
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          twitch: {
            accounts: {
              alerts: expect.objectContaining({
                accessToken: "oauth:new-access",
                refreshToken: "new-refresh",
                expiresIn: 3600,
                obtainmentTimestamp: 200,
              }),
            },
          },
        },
      }),
      expect.any(Object),
    );
  });

  it("skips config writes for env-backed tokens", async () => {
    await persistRefreshedTwitchTokens({
      accountId: "default",
      tokenSource: "env",
      token: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 3600,
        obtainmentTimestamp: 200,
      },
    });

    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });
});
