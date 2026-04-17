import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

type ExternalAuthProfiles = ReturnType<
  typeof import("../plugins/provider-runtime.js").resolveExternalAuthProfilesWithPlugins
>;

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<() => ExternalAuthProfiles>(() => []);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureAuthProfileStore: typeof import("./auth-profiles.js").ensureAuthProfileStore;

async function loadFreshAuthProfilesModuleForTest() {
  vi.resetModules();
  ({ clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore } =
    await import("./auth-profiles.js"));
}

function withAgentDirEnv(prefix: string, run: (agentDir: string) => void | Promise<void>) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return run(agentDir);
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
}

function writeAuthStore(agentDir: string, key: string) {
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
            key,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return authPath;
}

describe("auth profile store cache", () => {
  beforeEach(async () => {
    await loadFreshAuthProfilesModuleForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRuntimeAuthProfileStoreSnapshots();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    vi.clearAllMocks();
  });

  it("reuses the cached auth store while auth-profiles.json is unchanged", async () => {
    await withAgentDirEnv("openclaw-auth-store-cache-", (agentDir) => {
      const authPath = writeAuthStore(agentDir, "sk-test");
      const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

      ensureAuthProfileStore(agentDir);
      ensureAuthProfileStore(agentDir);

      expect(
        readFileSyncSpy.mock.calls.filter(([target]) => String(target) === authPath),
      ).toHaveLength(1);
    });
  });

  it("refreshes the cached auth store after auth-profiles.json changes", async () => {
    await withAgentDirEnv("openclaw-auth-store-refresh-", async (agentDir) => {
      const authPath = writeAuthStore(agentDir, "sk-test-1");
      const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

      ensureAuthProfileStore(agentDir);

      writeAuthStore(agentDir, "sk-test-2");
      const bumpedMtime = new Date(Date.now() + 2_000);
      fs.utimesSync(authPath, bumpedMtime, bumpedMtime);

      const reloaded = ensureAuthProfileStore(agentDir);

      expect(
        readFileSyncSpy.mock.calls.filter(([target]) => String(target) === authPath),
      ).toHaveLength(2);
      expect(reloaded.profiles["openai:default"]).toMatchObject({
        key: "sk-test-2",
      });
    });
  });

  it("reapplies runtime-only external auth overlays over a cached missing auth store", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-store-missing-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    let overlayCount = 0;
    resolveExternalAuthProfilesWithPluginsMock.mockImplementation(() => {
      overlayCount += 1;
      return [
        {
          profileId: "openai-codex:default",
          credential: {
            type: "oauth" as const,
            provider: "openai-codex",
            access: `access-${overlayCount}`,
            refresh: `refresh-${overlayCount}`,
            expires: Date.now() + 60_000,
          },
          persistence: "runtime-only" as const,
        },
      ];
    });
    try {
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);

      expect(first.profiles["openai-codex:default"]).toMatchObject({ access: "access-1" });
      expect(second.profiles["openai-codex:default"]).toMatchObject({ access: "access-2" });
      expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledTimes(2);
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
