import { describe, expect, it } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/extensions/directory.ts";
import type { OpenClawConfig } from "../runtime-api.js";
import { googlechatPlugin } from "./channel.js";

describe("googlechat directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: { allowFrom: ["users/alice", "googlechat:bob"] },
          groups: {
            "spaces/AAA": {},
            "spaces/BBB": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatPlugin.directory);

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
        { kind: "user", id: "users/alice" },
        { kind: "user", id: "bob" },
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
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "spaces/AAA" },
        { kind: "group", id: "spaces/BBB" },
      ]),
    );
  });
});
