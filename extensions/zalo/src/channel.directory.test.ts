import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk/zalo";
import { describe, expect, it } from "vitest";
import { createDirectoryTestRuntime, expectDirectorySurface } from "../../test-utils/directory.js";
import { zaloPlugin } from "./channel.js";

describe("zalo directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;

  it("lists peers from allowFrom", async () => {
    const cfg = {
      channels: {
        zalo: {
          allowFrom: ["zalo:123", "zl:234", "345"],
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(zaloPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "123" },
        { kind: "user", id: "234" },
        { kind: "user", id: "345" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual([]);
  });
});
