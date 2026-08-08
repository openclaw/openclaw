import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStore,
  markAuthProfileSuccess,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
  withAuthProfileStoreSnapshot,
} from "../auth-profiles.js";
import { readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

function snapshot(profileId: string, key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: "openai",
        key,
      },
    },
  };
}

describe("auth profile snapshot runtime", () => {
  it("loads and updates only the scoped in-memory store", () => {
    withAuthProfileStoreSnapshot(snapshot("openai:matrix", "sk-initial"), () => {
      expect(loadAuthProfileStore().profiles["openai:matrix"]).toMatchObject({
        key: "sk-initial",
      });
      saveAuthProfileStore(snapshot("openai:matrix", "sk-updated"), "/unreadable/agent");
      expect(ensureAuthProfileStore("/different/agent").profiles["openai:matrix"]).toMatchObject({
        key: "sk-updated",
      });
      expect(
        findPersistedAuthProfileCredential({
          agentDir: "/different/agent",
          profileId: "openai:matrix",
        }),
      ).toMatchObject({ key: "sk-updated" });
      expect(
        resolvePersistedAuthProfileOwnerAgentDir({
          agentDir: "/different/agent",
          profileId: "openai:matrix",
        }),
      ).toBeUndefined();
    });
  });

  it("isolates overlapping snapshot scopes", async () => {
    const [left, right] = await Promise.all([
      withAuthProfileStoreSnapshot(snapshot("openai:left", "sk-left"), async () => {
        await Promise.resolve();
        return Object.keys(loadAuthProfileStore().profiles);
      }),
      withAuthProfileStoreSnapshot(snapshot("openai:right", "sk-right"), async () => {
        await Promise.resolve();
        return Object.keys(loadAuthProfileStore().profiles);
      }),
    ]);
    expect(left).toEqual(["openai:left"]);
    expect(right).toEqual(["openai:right"]);
  });

  it("keeps locked success bookkeeping inside the snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-snapshot-lock-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    try {
      const scopedStore = snapshot("openai:matrix", "admitted-key-material");
      await withAuthProfileStoreSnapshot(scopedStore, async () => {
        await markAuthProfileSuccess({
          store: scopedStore,
          provider: "openai",
          profileId: "openai:matrix",
          agentDir,
        });
        expect(scopedStore.lastGood).toEqual({ openai: "openai:matrix" });
        expect(loadAuthProfileStore()).toMatchObject({
          lastGood: { openai: "openai:matrix" },
          profiles: {
            "openai:matrix": { key: "admitted-key-material" },
          },
        });
      });

      expect(readPersistedAuthProfileStoreRaw(agentDir)).toBeNull();
      expect(await fs.readdir(agentDir)).toEqual([]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});
