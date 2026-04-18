import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, type FileLockTimeoutError } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createExpiredOauthStore,
  resolveApiKeyForProfileInTest,
} from "./oauth-test-utils.js";
import { resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { clearRuntimeAuthProfileStoreSnapshots, saveAuthProfileStore } from "./store.js";
import type { OAuthCredential } from "./types.js";

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(
    async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
  ),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: async () => undefined,
}));

vi.mock("../../infra/file-lock.js", () => ({
  FILE_LOCK_TIMEOUT_ERROR_CODE: "file_lock_timeout",
  resetFileLockStateForTest: () => undefined,
  withFileLock: withFileLockMock,
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  FILE_LOCK_TIMEOUT_ERROR_CODE: "file_lock_timeout",
  resetFileLockStateForTest: () => undefined,
  withFileLock: withFileLockMock,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

vi.mock("./external-cli-sync.js", () => ({
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  hasUsableOAuthCredential: (credential: OAuthCredential | undefined, now = Date.now()) =>
    credential?.type === "oauth" &&
    credential.access.trim().length > 0 &&
    Number.isFinite(credential.expires) &&
    credential.expires - now > 5 * 60 * 1000,
  isSafeToUseExternalCliCredential: () => true,
  readExternalCliBootstrapCredential: () => null,
  readManagedExternalCliCredential: () => null,
  resolveExternalCliAuthProfiles: () => [],
  shouldBootstrapFromExternalCliCredential: () => false,
  shouldReplaceStoredOAuthCredential: (existing: unknown, incoming: unknown) =>
    existing !== incoming,
}));

function createLockTimeoutError(lockPath: string): FileLockTimeoutError {
  return Object.assign(new Error(`file lock timeout for ${lockPath.slice(0, -5)}`), {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE as typeof FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  });
}

describe("OAuth refresh lock timeout classification", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-lock-timeout-"));
    ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
  });

  beforeEach(async () => {
    withFileLockMock.mockReset();
    withFileLockMock.mockImplementation(
      async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
    );
    clearRuntimeAuthProfileStoreSnapshots();
    const caseRoot = path.join(tempRoot, `case-${++caseIndex}`);
    process.env.OPENCLAW_STATE_DIR = caseRoot;
    agentDir = path.join(caseRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("maps only global refresh lock timeouts to refresh_contention", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const store = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(store, agentDir);

    const refreshLockPath = `${resolveOAuthRefreshLockPath(provider, profileId)}.lock`;
    withFileLockMock.mockImplementationOnce(async () => {
      throw createLockTimeoutError(refreshLockPath);
    });

    try {
      await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store,
        profileId,
        agentDir,
      });
      throw new Error("expected refresh contention error");
    } catch (error) {
      expect((error as Error).message).toContain("another process is already refreshing");
      expect((error as Error).message).toContain(
        "Please wait for the in-flight refresh to finish and retry.",
      );
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: "refresh_contention",
      });
      expect(
        ((error as Error & { cause?: { cause?: unknown } }).cause as { cause?: unknown }).cause,
      ).toMatchObject({
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath: refreshLockPath,
      });
    }
  });

  it("preserves auth-store lock timeouts instead of remapping them to refresh_contention", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const store = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(store, agentDir);

    const authStoreLockPath = `${resolveAuthStorePath(agentDir)}.lock`;
    withFileLockMock
      .mockImplementationOnce(
        async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
      )
      .mockImplementationOnce(async () => {
        throw createLockTimeoutError(authStoreLockPath);
      });

    try {
      await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store,
        profileId,
        agentDir,
      });
      throw new Error("expected auth-store lock timeout");
    } catch (error) {
      expect((error as Error).message).toContain("file lock timeout");
      expect((error as Error).message).toContain("Please try again or re-authenticate.");
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath: authStoreLockPath,
      });
    }
  });
});
