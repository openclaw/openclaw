import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

const mocks = vi.hoisted(() => ({
  syncExternalCliCredentials: vi.fn(() => false),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: mocks.syncExternalCliCredentials,
}));

const { clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore } =
  await import("./auth-profiles.js");

describe("auth profile store cache", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.clearAllMocks();
  });

  it("reuses the synced auth store while auth-profiles.json is unchanged", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-store-cache-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-test",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      ensureAuthProfileStore(agentDir);
      ensureAuthProfileStore(agentDir);

      expect(mocks.syncExternalCliCredentials).toHaveBeenCalledTimes(1);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes the cached auth store after auth-profiles.json changes", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-store-refresh-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-test-1",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      ensureAuthProfileStore(agentDir);

      await new Promise((resolve) => setTimeout(resolve, 10));

      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-test-2",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const reloaded = ensureAuthProfileStore(agentDir);

      expect(mocks.syncExternalCliCredentials).toHaveBeenCalledTimes(2);
      expect(reloaded.profiles["openai:default"]).toMatchObject({
        key: "sk-test-2",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
