import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { AUTH_PROFILE_FILENAME } from "./path-constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";

const fixtureSuite = createFixtureSuite("openclaw-auth-runtime-snapshots-");

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await fixtureSuite.cleanup();
});

describe("runtime auth profile snapshots", () => {
  it("invalidates snapshots when the disk auth store is newer", async () => {
    await fixtureSuite.setup();
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const loadedAtMs = Date.now() - 10_000;
    replaceRuntimeAuthProfileStoreSnapshots(
      [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "stale-key",
              },
            },
          },
        },
      ],
      loadedAtMs,
    );

    await fs.writeFile(
      path.join(agentDir, AUTH_PROFILE_FILENAME),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "fresh-key",
          },
        },
      }),
      "utf8",
    );

    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });
});
