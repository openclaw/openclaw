import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  syncExternalCliCredentials: vi.fn((store: AuthProfileStore) => {
    store.profiles["qwen-portal:default"] = {
      type: "oauth",
      provider: "qwen-portal",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    };
    return true;
  }),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: mocks.syncExternalCliCredentials,
}));

const { loadAuthProfileStoreForRuntime } = await import("./auth-profiles.js");

describe("auth profiles read-only external CLI sync", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("syncs external CLI credentials in-memory without writing auth-profiles.json in read-only mode", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-readonly-sync-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const baseline: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      };
      fs.writeFileSync(authPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

      const loaded = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(mocks.syncExternalCliCredentials).toHaveBeenCalled();
      expect(loaded.profiles["qwen-portal:default"]).toMatchObject({
        type: "oauth",
        provider: "qwen-portal",
      });

      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthProfileStore;
      expect(persisted.profiles["qwen-portal:default"]).toBeUndefined();
      expect(persisted.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
