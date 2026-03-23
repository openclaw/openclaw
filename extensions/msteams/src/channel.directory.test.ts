import { describe, expect, it } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/extensions/directory.js";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { msteamsPlugin } from "./channel.js";

function requireDirectorySelf(
  directory: typeof msteamsPlugin.directory | null | undefined,
): NonNullable<NonNullable<typeof msteamsPlugin.directory>["self"]> {
  if (!directory?.self) {
    throw new Error("expected msteams directory.self");
  }
  return directory.self;
}

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;
  const directorySelf = requireDirectorySelf(msteamsPlugin.directory);

  describe("self()", () => {
    it("returns bot identity when credentials are configured", async () => {
      const cfg = {
        channels: {
          msteams: {
            appId: "test-app-id-1234",
            appPassword: "secret",
            tenantId: "tenant-id-5678",
          },
        },
      } as unknown as OpenClawConfig;

      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toEqual({ kind: "user", id: "test-app-id-1234", name: "test-app-id-1234" });
    });

    it("returns null when credentials are not configured", async () => {
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toBeNull();
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["alice", "user:Bob"],
          dms: { carol: {}, bob: {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:alice" },
        { kind: "user", id: "user:Bob" },
        { kind: "user", id: "user:carol" },
        { kind: "user", id: "user:bob" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "conversation:chan1" },
        { kind: "group", id: "conversation:chan2" },
      ]),
    );
  });

  it("normalizes spaced allowlist and dm entries", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["  user:Bob  ", "  Alice  "],
          dms: { "  Carol  ": {}, "user:Dave": {} },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:Bob" },
        { kind: "user", id: "user:Alice" },
        { kind: "user", id: "user:Carol" },
        { kind: "user", id: "user:Dave" },
      ]),
    );
  });
});
