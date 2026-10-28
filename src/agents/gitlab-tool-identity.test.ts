import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishSecretStoreChange } from "../secrets/store/secret-store-changes.js";
import type { GitLabManagedOAuthRecord } from "./gitlab-managed-records.js";
import { notifyManagedGitLabProfileChanged } from "./gitlab-tool-identity-lifecycle.js";

const state = vi.hoisted(() => ({
  record: undefined as unknown,
  effects: [] as string[],
}));
vi.mock("./gitlab-managed-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitlab-managed-records.js")>()),
  inspectGitLabManagedOAuthRecord: async () => ({ state: "valid", record: state.record }),
  writeGitLabManagedOAuthRecord: async (next: unknown) => {
    state.effects.push("record");
    state.record = next;
  },
}));
vi.mock("./gitlab-oauth-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitlab-oauth-client.js")>()),
  refreshGitLabAuthorization: async () => {
    state.effects.push("provider");
    return {
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAtMs: Date.now() + 3600_000,
      scopes: ["api", "write_repository"],
    };
  },
  verifyGitLabAccount: async () => ({
    accountId: 42,
    login: "bot",
    name: "Verified Bot",
    commitEmail: "bot@example.com",
    issuer: "https://gitlab.example",
  }),
}));
vi.mock("./gitlab-tool-profile-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitlab-tool-profile-files.js")>()),
  writeManagedGitLabProfileFiles: async () => {
    state.effects.push("profile");
  },
  readManagedGitLabProfileToken: async () => "next-access",
}));
// mock-isolation: This credential unit fixture must not admit a real state database or worker.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadContext: () => ({
    admission: { databasePath: "/tmp/managed-gitlab-test.db", assertCurrent: () => undefined },
    assertPublicationCurrent: () => undefined,
  }),
}));

import {
  prepareGitLabToolCredential,
  refreshManagedGitLabProfile,
  resolveGitLabToolIdentityStatus,
  resolveManagedGitLabProfileDir,
} from "./gitlab-tool-identity.js";

const identity = {
  profileId: "glp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  issuer: "https://gitlab.example",
};
const config = { tools: { gitlab: identity } } as OpenClawConfig;
const oauthConfig = {
  issuer: identity.issuer,
  clientId: "public-client",
  redirectUri: "https://gateway.example/oauth/gitlab/callback",
};
const account = {
  accountId: 42,
  login: "bot",
  name: "Verified Bot",
  commitEmail: "bot@example.com",
  issuer: identity.issuer,
};

beforeEach(() => {
  state.effects.length = 0;
  state.record = {
    version: 1,
    profileId: identity.profileId,
    scope: "system",
    agentId: "main",
    issuer: identity.issuer,
    account,
    tokens: {
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      expiresAtMs: Date.now() - 1000,
      scopes: ["api", "write_repository"],
    },
    createdAtMs: Date.now() - 3600_000,
  } satisfies GitLabManagedOAuthRecord;
});

describe("managed GitLab refresh", () => {
  it("claims an expired access token before rotating, then writes glab profile before settlement", async () => {
    await expect(
      refreshManagedGitLabProfile({
        config,
        getCurrentConfig: () => config,
        scope: "system",
        agentId: "main",
        oauthConfig,
      }),
    ).resolves.toEqual(account);
    expect(state.effects).toEqual(["record", "provider", "profile", "record"]);
    expect((state.record as GitLabManagedOAuthRecord).tokens.accessToken).toBe("next-access");
    expect((state.record as GitLabManagedOAuthRecord).refreshClaim).toBeUndefined();
  });

  it("refreshes the exact selected scope during status inspection", async () => {
    const result = await resolveGitLabToolIdentityStatus({
      config,
      getCurrentConfig: () => config,
      selectedScope: "system",
      agentId: "main",
      oauthConfig,
    });
    expect(state.effects).toEqual(["record", "provider", "profile", "record"]);
    expect(result.selected?.credentialState).toBe("available");
    expect(result.selected?.account).toEqual(account);
  });

  it("revokes a prepared synchronous credential on hidden record and profile changes", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-managed-identity-"));
    const env = { OPENCLAW_STATE_DIR: temporary };
    const profileDir = resolveManagedGitLabProfileDir({
      scope: "system",
      agentId: "main",
      profileId: identity.profileId,
      env,
    });
    try {
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(profileDir, "config.yml"), "private", { mode: 0o600 });
      state.record = {
        ...(state.record as GitLabManagedOAuthRecord),
        tokens: {
          accessToken: "next-access",
          refreshToken: "next-refresh",
          expiresAtMs: Date.now() + 3600_000,
          scopes: ["api", "write_repository"],
        },
      };
      const prepare = () =>
        prepareGitLabToolCredential({
          config,
          getCurrentConfig: () => config,
          agentId: "main",
          oauthConfig,
          env,
        });
      const first = await prepare();
      first.assertCurrentSync();
      publishSecretStoreChange("/tmp/managed-gitlab-test.db", [
        `gitlab-oauth-${identity.profileId.slice(4)}`,
      ]);
      expect(() => first.assertCurrentSync()).toThrow("credential changed");
      first.close();

      const second = await prepare();
      notifyManagedGitLabProfileChanged({ profileDir, kind: "updated" });
      expect(() => second.assertCurrentSync()).toThrow("credential changed");
      second.close();
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});
