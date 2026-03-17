import { describe, expect, it } from "vitest";
import { createDirectoryTestRuntime, expectDirectorySurface } from "../../test-utils/directory.js";
import { zaloPlugin } from "./channel.js";
describe("zalo directory", () => {
  const runtimeEnv = createDirectoryTestRuntime();
  it("lists peers from allowFrom", async () => {
    const cfg = {
      channels: {
        zalo: {
          allowFrom: ["zalo:123", "zl:234", "345"]
        }
      }
    };
    const directory = expectDirectorySurface(zaloPlugin.directory);
    await expect(
      directory.listPeers({
        cfg,
        accountId: void 0,
        query: void 0,
        limit: void 0,
        runtime: runtimeEnv
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "123" },
        { kind: "user", id: "234" },
        { kind: "user", id: "345" }
      ])
    );
    await expect(
      directory.listGroups({
        cfg,
        accountId: void 0,
        query: void 0,
        limit: void 0,
        runtime: runtimeEnv
      })
    ).resolves.toEqual([]);
  });
});
