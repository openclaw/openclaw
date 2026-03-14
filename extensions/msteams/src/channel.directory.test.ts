import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { describe, expect, it } from "vitest";
import { createDirectoryTestRuntime, expectDirectorySurface } from "../../test-utils/directory.js";
import { msteamsPlugin } from "./channel.js";

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;

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
});
