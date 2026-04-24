import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { AUTH_PROFILE_FILENAME } from "./path-constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
  updateRuntimeAuthProfileStoreSnapshotIfPresent,
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

  it("does not invalidate snapshots when an unsnapshotted store key is newer", async () => {
    await fixtureSuite.setup();
    const snapshottedAgentDir = await fixtureSuite.createCaseDir("snapshotted-agent");
    const unsnapshottedAgentDir = await fixtureSuite.createCaseDir("unsnapshotted-agent");
    replaceRuntimeAuthProfileStoreSnapshots(
      [
        {
          agentDir: snapshottedAgentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "snapshotted-key",
              },
            },
          },
        },
      ],
      Date.now() - 10_000,
    );

    await fs.writeFile(
      path.join(unsnapshottedAgentDir, AUTH_PROFILE_FILENAME),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "other-key",
          },
        },
      }),
      "utf8",
    );

    expect(getRuntimeAuthProfileStoreSnapshot(unsnapshottedAgentDir)).toBeUndefined();
    expect(
      getRuntimeAuthProfileStoreSnapshot(snapshottedAgentDir)?.profiles["openai:default"],
    ).toMatchObject({
      key: "snapshotted-key",
    });
  });

  it("refreshes an existing snapshot without first invalidating on disk mtime", async () => {
    await fixtureSuite.setup();
    const agentDir = await fixtureSuite.createCaseDir("agent");
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
                key: "old-runtime-key",
              },
            },
          },
        },
      ],
      Date.now() - 10_000,
    );
    await fs.writeFile(
      path.join(agentDir, AUTH_PROFILE_FILENAME),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "new-disk-key",
          },
        },
      }),
      "utf8",
    );

    expect(
      updateRuntimeAuthProfileStoreSnapshotIfPresent(
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "new-runtime-key",
            },
          },
        },
        agentDir,
      ),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "new-runtime-key",
    });
  });

  it("keeps stale detection independent for each snapshotted store key", async () => {
    await fixtureSuite.setup();
    const agentADir = await fixtureSuite.createCaseDir("agent-a");
    const agentBDir = await fixtureSuite.createCaseDir("agent-b");
    replaceRuntimeAuthProfileStoreSnapshots(
      [
        {
          agentDir: agentADir,
          store: {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "agent-a-old",
              },
            },
          },
        },
        {
          agentDir: agentBDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "agent-b-old",
              },
            },
          },
        },
      ],
      Date.now() - 10_000,
    );
    await fs.writeFile(
      path.join(agentBDir, AUTH_PROFILE_FILENAME),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "agent-b-new-disk",
          },
        },
      }),
      "utf8",
    );

    expect(
      updateRuntimeAuthProfileStoreSnapshotIfPresent(
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "agent-a-new-runtime",
            },
          },
        },
        agentADir,
      ),
    ).toBe(true);

    expect(getRuntimeAuthProfileStoreSnapshot(agentBDir)).toBeUndefined();
  });
});
