import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { clearLastGoodProfileWithLock, promoteAuthProfileInOrder } from "./profiles.js";
import { loadAuthProfileStoreForRuntime, saveAuthProfileStore } from "./store.js";

describe("promoteAuthProfileInOrder", () => {
  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    try {
      const newProfileId = "openai-codex:bunsthedev@gmail.com";
      const staleProfileId = "openai-codex:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai-codex",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai-codex"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai-codex"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("clearLastGoodProfileWithLock", () => {
  it("clears lastGood for a provider when profileId matches the stale entry (#79021)", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-"));
    try {
      const staleProfileId = "openai-codex:stale@example.com";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          lastGood: { "openai-codex": staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        provider: "openai-codex",
        profileId: staleProfileId,
        agentDir,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not clear lastGood when profileId does not match the stored entry (#79021)", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-ne-"));
    try {
      const goodProfileId = "openai-codex:good@example.com";
      const otherProfileId = "openai-codex:other@example.com";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "good-access",
              refresh: "good-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
          lastGood: { "openai-codex": goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        provider: "openai-codex",
        profileId: otherProfileId,
        agentDir,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai-codex"]).toBe(
        goodProfileId,
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
