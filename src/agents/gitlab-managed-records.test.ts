import { beforeEach, describe, expect, it, vi } from "vitest";

const hidden = vi.hoisted(() => new Map<string, string>());
vi.mock("../secrets/store/secret-store-hidden-managed-gitlab.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../secrets/store/secret-store-hidden-managed-gitlab.js")
  >()),
  writeHiddenGitLabSecretRecord: async ({
    name,
    value,
    expectedValue,
    expectedAbsent,
  }: {
    name: string;
    value: string;
    expectedValue?: string;
    expectedAbsent?: boolean;
  }) => {
    if (expectedAbsent && hidden.has(name)) {
      throw new Error("record already exists");
    }
    if (expectedValue !== undefined && hidden.get(name) !== expectedValue) {
      throw new Error("record changed");
    }
    hidden.set(name, value);
  },
  readHiddenGitLabSecretRecord: async ({ name }: { name: string }) => hidden.get(name),
  listHiddenGitLabSecretRecords: async ({ prefix }: { prefix: string }) =>
    [...hidden]
      .filter(([name]) => name.startsWith(`${prefix}-`))
      .map(([name, value]) => ({ name, value })),
  deleteHiddenGitLabSecretRecord: async ({ name }: { name: string }) => {
    hidden.delete(name);
  },
}));

import {
  AgentGitLabToolIdentitySchema,
  GitLabToolIdentitySchema,
} from "../config/zod-schema.gitlab-identity.js";
import { isHiddenGitLabStoreName } from "../secrets/store/secret-store-gitlab-names.js";
import {
  createGitLabManagedOAuthRecord,
  createManagedGitLabProfileId,
  createManagedGitLabSetupRequestId,
  inspectGitLabManagedOAuthRecord,
  readGitLabManagedSetupRecord,
  writeGitLabManagedOAuthRecord,
  writeGitLabManagedSetupRecord,
} from "./gitlab-managed-records.js";

const issuer = "https://gitlab.com";
const account = {
  accountId: 42,
  login: "operator",
  name: "Verified Operator",
  commitEmail: "operator@example.com",
  issuer,
};
const tokens = {
  accessToken: "new-access",
  refreshToken: "new-refresh",
  expiresAtMs: Date.now() + 3600_000,
  scopes: ["api", "write_repository"],
};

beforeEach(() => hidden.clear());

describe("managed GitLab identity custody", () => {
  it("keeps managed records opaque, hidden from generic secret names, and CAS guarded", async () => {
    const profileId = createManagedGitLabProfileId();
    const record = createGitLabManagedOAuthRecord({
      profileId,
      scope: "system",
      agentId: "main",
      account,
      tokens,
    });
    await writeGitLabManagedOAuthRecord(record);
    expect(isHiddenGitLabStoreName(`gitlab-oauth-${profileId.slice(4)}`)).toBe(true);
    expect(await inspectGitLabManagedOAuthRecord(profileId)).toEqual({ state: "valid", record });
    await expect(writeGitLabManagedOAuthRecord(record)).rejects.toThrow("already exists");
    await writeGitLabManagedOAuthRecord({ ...record, refreshClaim: crypto.randomUUID() }, record);
    await expect(
      writeGitLabManagedOAuthRecord({ ...record, refreshFailure: "failed" }, record),
    ).rejects.toThrow("changed");
  });

  it("rejects a credential whose actor issuer differs from its credential issuer", async () => {
    const record = createGitLabManagedOAuthRecord({
      profileId: createManagedGitLabProfileId(),
      scope: "system",
      agentId: "main",
      account,
      tokens,
    });
    await expect(
      writeGitLabManagedOAuthRecord({ ...record, issuer: "https://other.example" }),
    ).rejects.toThrow();
  });

  it("binds a pending setup to exact request, initiator, issuer, and managed state", async () => {
    const requestId = createManagedGitLabSetupRequestId();
    const createdAtMs = Date.now();
    const record = {
      version: 1 as const,
      requestId,
      scope: "system" as const,
      agentId: "main",
      initiatorProfileId: "real-admin-profile",
      issuer,
      configFingerprint: "a".repeat(64),
      expectedIdentity: null,
      state: `gitlab-managed.${requestId}.${"b".repeat(43)}`,
      verifier: "c".repeat(43),
      createdAtMs,
      expiresAtMs: createdAtMs + 600_000,
    };
    await writeGitLabManagedSetupRecord(record);
    expect(await readGitLabManagedSetupRecord(requestId)).toEqual(record);
    expect(isHiddenGitLabStoreName(requestId)).toBe(true);
    await expect(
      writeGitLabManagedSetupRecord({
        ...record,
        state: `gitlab-managed.${createManagedGitLabSetupRequestId()}.${"b".repeat(43)}`,
      }),
    ).rejects.toThrow();
  });
});

describe("GitLab config selection", () => {
  it("accepts public and self-hosted HTTPS origins with opaque IDs and rejects non-origins", () => {
    const profileId = createManagedGitLabProfileId();
    expect(GitLabToolIdentitySchema.safeParse({ profileId, issuer }).success).toBe(true);
    expect(
      AgentGitLabToolIdentitySchema.safeParse({
        profileId,
        issuer: "https://gitlab.example:8443",
        allowInSandbox: false,
      }).success,
    ).toBe(true);
    expect(
      GitLabToolIdentitySchema.safeParse({ profileId, issuer: "https://gitlab.example/path" })
        .success,
    ).toBe(false);
    expect(
      GitLabToolIdentitySchema.safeParse({ profileId, issuer: "http://gitlab.example" }).success,
    ).toBe(false);
    expect(GitLabToolIdentitySchema.safeParse({ profileId, issuer, token: "leak" }).success).toBe(
      false,
    );
  });
});
