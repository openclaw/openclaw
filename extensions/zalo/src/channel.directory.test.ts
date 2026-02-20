import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("zalo directory", () => {
  const runtimeEnv: RuntimeEnv = {
    log: () => {},
    error: () => {},
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  it("lists peers from allowFrom", async () => {
    const cfg = {
      channels: {
        zalo: {
          allowFrom: ["zalo:123", "zl:234", "345"],
        },
      },
    } as unknown as OpenClawConfig;

    expect(zaloPlugin.directory).toBeTruthy();
    expect(zaloPlugin.directory?.listPeers).toBeTruthy();
    expect(zaloPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      zaloPlugin.directory!.listPeers!({
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
      zaloPlugin.directory!.listGroups!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual([]);
  });
});
