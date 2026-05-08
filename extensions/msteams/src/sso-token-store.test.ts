import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createMSTeamsSsoTokenStore, parseMSTeamsSsoTokenStoreData } from "./sso-token-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("msteams sso token store", () => {
  it("keeps distinct tokens when connectionName and userId contain the legacy delimiter", async () => {
    const stateDir = await makeTempDir("openclaw-msteams-sso-");
    const storePath = path.join(stateDir, "msteams-sso-tokens.json");
    const store = createMSTeamsSsoTokenStore({ stateDir });

    const first = {
      connectionName: "conn::alpha",
      userId: "user",
      token: "token-a",
      updatedAt: "2026-04-10T00:00:00.000Z",
    } as const;
    const second = {
      connectionName: "conn",
      userId: "alpha::user",
      token: "token-b",
      updatedAt: "2026-04-10T00:00:01.000Z",
    } as const;

    await store.save(first);
    await store.save(second);

    expect(await store.get(first)).toEqual(first);
    expect(await store.get(second)).toEqual(second);
    await expect(fs.access(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses legacy flat-key files by rebuilding keys from stored token payloads", () => {
    const parsed = parseMSTeamsSsoTokenStoreData({
      version: 1,
      tokens: {
        "legacy::wrong-key": {
          connectionName: "conn",
          userId: "user-1",
          token: "token-1",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      },
    });

    expect(Object.values(parsed ?? {})).toEqual([
      {
        connectionName: "conn",
        userId: "user-1",
        token: "token-1",
        updatedAt: "2026-04-10T00:00:00.000Z",
      },
    ]);
  });

  it("removes tokens from SQLite storage", async () => {
    const stateDir = await makeTempDir("openclaw-msteams-sso-remove-");
    const store = createMSTeamsSsoTokenStore({ stateDir });
    await store.save({
      connectionName: "conn",
      userId: "user-1",
      token: "token-1",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });

    await expect(
      store.remove({
        connectionName: "conn",
        userId: "user-1",
      }),
    ).resolves.toBe(true);
    await expect(
      store.get({
        connectionName: "conn",
        userId: "user-1",
      }),
    ).resolves.toBeNull();
  });
});
