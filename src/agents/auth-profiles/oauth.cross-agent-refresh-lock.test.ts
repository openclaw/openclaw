import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [
    {
      id: "openai-codex",
      envApiKey: "OPENAI_API_KEY",
      oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
    },
  ],
}));

import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access: string;
  refresh: string;
  expires: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access,
        refresh: params.refresh,
        expires: params.expires,
      },
    },
  };
}

describe("cross-agent OAuth refresh serialization", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  let tempRoot = "";
  let mainAgentDir = "";
  let operatorAgentDir = "";
  let selfAnalysisAgentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cross-agent-refresh-"));
    mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    operatorAgentDir = path.join(tempRoot, "agents", "operator", "agent");
    selfAnalysisAgentDir = path.join(tempRoot, "agents", "self-analysis", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(operatorAgentDir, { recursive: true });
    await fs.mkdir(selfAnalysisAgentDir, { recursive: true });

    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function resolveFromAgent(agentDir: string, profileId: string) {
    return await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });
  }

  it("serializes refresh across agents and syncs the winning credentials back to main", async () => {
    const profileId = "openai-codex:default";
    const expiredAt = Date.now() - 60_000;
    const refreshedAt = Date.now() + 60 * 60 * 1000;
    const staleRefresh = "stale-refresh-token";

    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "main-stale-access",
        refresh: staleRefresh,
        expires: expiredAt,
      }),
      mainAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "operator-stale-access",
        refresh: staleRefresh,
        expires: expiredAt,
      }),
      operatorAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "self-analysis-stale-access",
        refresh: staleRefresh,
        expires: expiredAt,
      }),
      selfAnalysisAgentDir,
    );

    let releaseFirstRefresh: (() => void) | null = null;
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      return await new Promise((resolve) => {
        releaseFirstRefresh = () => {
          resolve({
            apiKey: "fresh-access-token",
            newCredentials: {
              access: "fresh-access-token",
              refresh: "fresh-refresh-token",
              expires: refreshedAt,
            },
          });
        };
      });
    });
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("refresh should only run once");
    });

    const operatorResolve = resolveFromAgent(operatorAgentDir, profileId);
    await vi.waitFor(() => {
      expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
      expect(releaseFirstRefresh).not.toBeNull();
    });
    const selfAnalysisResolve = resolveFromAgent(selfAnalysisAgentDir, profileId);

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
    expect(releaseFirstRefresh).not.toBeNull();
    releaseFirstRefresh?.();

    const [operatorResult, selfAnalysisResult] = await Promise.all([
      operatorResolve,
      selfAnalysisResolve,
    ]);

    expect(operatorResult).toEqual({
      apiKey: "fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(selfAnalysisResult).toEqual({
      apiKey: "fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);

    const mainStore = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    const operatorStore = JSON.parse(
      await fs.readFile(path.join(operatorAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    const selfAnalysisStore = JSON.parse(
      await fs.readFile(path.join(selfAnalysisAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;

    expect(mainStore.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: refreshedAt,
    });
    expect(operatorStore.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: refreshedAt,
    });
    expect(selfAnalysisStore.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: refreshedAt,
    });
  });
});
