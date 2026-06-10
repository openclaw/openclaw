import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverSignalAccountUuid,
  resolveConfiguredSignalAccountUuid,
  resolveSignalCliAccountsPath,
} from "./account-store.js";

type ReadFile = typeof import("node:fs/promises").readFile;

describe("signal-cli account store", () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalSignalCliConfig = process.env.SIGNAL_CLI_CONFIG;

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalSignalCliConfig === undefined) {
      delete process.env.SIGNAL_CLI_CONFIG;
    } else {
      process.env.SIGNAL_CLI_CONFIG = originalSignalCliConfig;
    }
  });

  it("uses configured UUIDs only when they match the effective account override", () => {
    expect(
      resolveConfiguredSignalAccountUuid({
        configuredAccount: "+15550001111",
        configuredAccountUuid: "123e4567-e89b-12d3-a456-426614174000",
        effectiveAccount: "+15550001111",
        accountOverridden: true,
      }),
    ).toBe("123e4567-e89b-12d3-a456-426614174000");

    expect(
      resolveConfiguredSignalAccountUuid({
        configuredAccount: "+15550001111",
        configuredAccountUuid: "123e4567-e89b-12d3-a456-426614174000",
        effectiveAccount: "+15550002222",
        accountOverridden: true,
      }),
    ).toBeUndefined();

    expect(
      resolveConfiguredSignalAccountUuid({
        configuredAccountUuid: "123e4567-e89b-12d3-a456-426614174000",
        accountOverridden: false,
      }),
    ).toBe("123e4567-e89b-12d3-a456-426614174000");

    expect(
      resolveConfiguredSignalAccountUuid({
        configuredAccountUuid: " uuid:123e4567-e89b-12d3-a456-426614174000 ",
        accountOverridden: false,
      }),
    ).toBe("123e4567-e89b-12d3-a456-426614174000");

    expect(
      resolveConfiguredSignalAccountUuid({
        configuredAccountUuid: "legacy copied sender id",
        accountOverridden: false,
      }),
    ).toBeUndefined();
  });

  it("resolves the default signal-cli accounts file", () => {
    delete process.env.XDG_DATA_HOME;

    expect(resolveSignalCliAccountsPath()).toBe(
      path.join(os.homedir(), ".local", "share", "signal-cli", "data", "accounts.json"),
    );
  });

  it("resolves the XDG signal-cli accounts file", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";

    expect(resolveSignalCliAccountsPath()).toBe(
      path.join("/tmp/xdg-data", "signal-cli", "data", "accounts.json"),
    );
  });

  it("resolves the configured signal-cli accounts file", () => {
    expect(resolveSignalCliAccountsPath("~/signal-data")).toBe(
      path.join(os.homedir(), "signal-data", "data", "accounts.json"),
    );
  });

  it("expands Windows-style home-relative configured paths", () => {
    expect(resolveSignalCliAccountsPath("~\\signal-data")).toBe(
      path.join(os.homedir(), "signal-data", "data", "accounts.json"),
    );
  });

  it("discovers the UUID for the configured account number", async () => {
    const readFile = vi.fn(async () =>
      JSON.stringify({
        accounts: [
          {
            number: "+15550001111",
            uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          },
        ],
      }),
    );

    await expect(
      discoverSignalAccountUuid({
        account: "+1 (555) 000-1111",
        configPath: "/tmp/signal-cli",
        readFile: readFile as unknown as ReadFile,
      }),
    ).resolves.toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(readFile).toHaveBeenCalledWith(
      path.join("/tmp/signal-cli", "data", "accounts.json"),
      "utf8",
    );
  });

  it("discovers the UUID from signal-cli config dataDir", async () => {
    process.env.SIGNAL_CLI_CONFIG = "/tmp/signal-cli-config.json";
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    const readFile = vi.fn(async (filePath: string | URL) => {
      if (String(filePath) === "/tmp/signal-cli-config.json") {
        return JSON.stringify({ dataDir: "/tmp/signal-cli-env-data" });
      }
      if (String(filePath) === path.join("/tmp/xdg-config", "signal-cli", "config.json")) {
        return JSON.stringify({ dataDir: "/tmp/signal-cli-user-data" });
      }
      if (String(filePath) === path.join("/tmp/signal-cli-user-data", "data", "accounts.json")) {
        return JSON.stringify({
          accounts: [
            {
              number: "+15550001111",
              uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
          ],
        });
      }
      throw new Error(`unexpected path ${String(filePath)}`);
    });

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: readFile as unknown as ReadFile,
      }),
    ).resolves.toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(readFile).toHaveBeenCalledWith("/etc/signal-cli/config.json", "utf8");
    expect(readFile).toHaveBeenCalledWith("/tmp/signal-cli-config.json", "utf8");
    expect(readFile).toHaveBeenCalledWith(
      path.join("/tmp/xdg-config", "signal-cli", "config.json"),
      "utf8",
    );
    expect(readFile).toHaveBeenCalledWith(
      path.join("/tmp/signal-cli-user-data", "data", "accounts.json"),
      "utf8",
    );
  });

  it("does not fall back to the default signal-cli store when configured dataDir is stale", async () => {
    process.env.SIGNAL_CLI_CONFIG = "/tmp/signal-cli-config.json";
    const defaultStore = resolveSignalCliAccountsPath();
    const readFile = vi.fn(async (filePath: string | URL) => {
      if (String(filePath) === "/tmp/signal-cli-config.json") {
        return JSON.stringify({ dataDir: "/tmp/missing-signal-cli-data" });
      }
      if (String(filePath) === defaultStore) {
        return JSON.stringify({
          accounts: [
            {
              number: "+15550001111",
              uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
          ],
        });
      }
      throw new Error(`missing ${String(filePath)}`);
    });

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: readFile as unknown as ReadFile,
      }),
    ).resolves.toBeUndefined();
    expect(readFile).toHaveBeenCalledWith(
      path.join("/tmp/missing-signal-cli-data", "data", "accounts.json"),
      "utf8",
    );
    expect(readFile).not.toHaveBeenCalledWith(defaultStore, "utf8");
  });

  it("does not fall back to the default signal-cli store when configured dataDir is ambiguous", async () => {
    process.env.SIGNAL_CLI_CONFIG = "/tmp/signal-cli-config.json";
    const defaultStore = resolveSignalCliAccountsPath();
    const readFile = vi.fn(async (filePath: string | URL) => {
      if (String(filePath) === "/tmp/signal-cli-config.json") {
        return JSON.stringify({ dataDir: "/tmp/ambiguous-signal-cli-data" });
      }
      if (
        String(filePath) === path.join("/tmp/ambiguous-signal-cli-data", "data", "accounts.json")
      ) {
        return JSON.stringify({
          accounts: [
            { number: "+15550001111", uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
            { number: "+1 (555) 000-1111", uuid: "123e4567-e89b-12d3-a456-426614174000" },
          ],
        });
      }
      if (String(filePath) === defaultStore) {
        return JSON.stringify({
          accounts: [
            {
              number: "+15550001111",
              uuid: "999e4567-e89b-12d3-a456-426614174999",
            },
          ],
        });
      }
      throw new Error(`missing ${String(filePath)}`);
    });

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: readFile as unknown as ReadFile,
      }),
    ).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalledWith(defaultStore, "utf8");
  });

  it("does not choose an ambiguous UUID when multiple account rows match", async () => {
    const readFile = vi.fn(async () =>
      JSON.stringify({
        accounts: [
          {
            number: "+15550001111",
            uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          },
          {
            number: "+1 (555) 000-1111",
            uuid: "123e4567-e89b-12d3-a456-426614174000",
          },
        ],
      }),
    );

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: readFile as unknown as ReadFile,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores missing or malformed account stores", async () => {
    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: vi.fn(async () => {
          throw new Error("missing");
        }) as unknown as ReadFile,
      }),
    ).resolves.toBeUndefined();

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: vi.fn(async () => "not-json") as unknown as ReadFile,
      }),
    ).resolves.toBeUndefined();
  });
});
