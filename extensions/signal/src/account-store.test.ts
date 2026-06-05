import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSignalAccountUuid, resolveSignalCliAccountsPath } from "./account-store.js";

describe("signal-cli account store", () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
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
        readFile: readFile as typeof import("node:fs/promises").readFile,
      }),
    ).resolves.toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(readFile).toHaveBeenCalledWith(
      path.join("/tmp/signal-cli", "data", "accounts.json"),
      "utf8",
    );
  });

  it("ignores missing or malformed account stores", async () => {
    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: vi.fn(async () => {
          throw new Error("missing");
        }) as typeof import("node:fs/promises").readFile,
      }),
    ).resolves.toBeUndefined();

    await expect(
      discoverSignalAccountUuid({
        account: "+15550001111",
        readFile: vi.fn(async () => "not-json") as typeof import("node:fs/promises").readFile,
      }),
    ).resolves.toBeUndefined();
  });
});
