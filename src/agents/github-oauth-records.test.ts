import { beforeEach, describe, expect, it, vi } from "vitest";

const hiddenStore = vi.hoisted(() => ({ records: new Map<string, string>() }));

vi.mock("../secrets/store/secret-store-hidden-github.js", () => ({
  deleteHiddenGitHubSecretRecord: ({ name }: { name: string }) => hiddenStore.records.delete(name),
  listHiddenGitHubSecretRecords: ({ prefix }: { prefix: string }) =>
    [...hiddenStore.records.entries()]
      .filter(([name]) => name.startsWith(`${prefix}-`))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value })),
  readHiddenGitHubSecretRecord: ({ name }: { name: string }) => hiddenStore.records.get(name),
  writeHiddenGitHubSecretRecord: ({ name, value }: { name: string; value: string }) =>
    hiddenStore.records.set(name, value),
}));

import {
  deleteGitHubDeviceAuthorizationRecord,
  deleteGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  type GitHubDeviceAuthorizationRecord,
  type GitHubOAuthRecord,
} from "./github-oauth-records.js";

const requestId = `github-device-${"1".repeat(32)}`;
const profileId = `ghp_${"2".repeat(32)}`;
const now = Date.parse("2026-08-19T12:00:00.000Z");

const deviceRecord: GitHubDeviceAuthorizationRecord = {
  version: 1,
  requestId,
  deviceCode: "a".repeat(40),
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  createdAtMs: now,
  expiresAtMs: now + 15 * 60_000,
  pollIntervalMs: 5_000,
  nextPollAtMs: now + 5_000,
  agentId: "main",
  scope: "agent",
  expectedIdentity: {
    profileId,
    allowInSandbox: true,
    gitAuthor: { name: "  Original Author  ", email: "  original@example.test  " },
  },
  agentLifecycleBinding: {
    agentId: "main",
    provenance: null,
  },
};

const oauthRecord: GitHubOAuthRecord = {
  version: 1,
  profileId,
  agentId: "main",
  scope: "agent",
  accountId: 3803641,
  login: "roboclaw-bot",
  refreshToken: "refresh-token-secret",
  accessExpiresAtMs: now + 8 * 60 * 60_000,
  refreshExpiresAtMs: now + 180 * 24 * 60 * 60_000,
  scopes: ["offline_access", "repo", "workflow"],
  createdAtMs: now,
};

describe("GitHub OAuth hidden records", async () => {
  beforeEach(() => hiddenStore.records.clear());

  it("round-trips exact pending and refresh records under opaque hidden names", async () => {
    await writeGitHubDeviceAuthorizationRecord(deviceRecord);
    await writeGitHubOAuthRecord(oauthRecord);

    expect([...hiddenStore.records.keys()]).toEqual([
      requestId,
      `github-oauth-${profileId.slice("ghp_".length)}`,
    ]);
    expect(await listGitHubDeviceAuthorizationRecords()).toEqual([
      { requestId, record: deviceRecord },
    ]);
    expect(await listGitHubOAuthRecords()).toEqual([{ profileId, record: oauthRecord }]);
    expect(await readGitHubDeviceAuthorizationRecord(requestId)).toEqual(deviceRecord);
    expect(await inspectGitHubOAuthRecord(profileId)).toEqual({
      state: "valid",
      record: oauthRecord,
    });
    expect(JSON.stringify([...hiddenStore.records.keys()])).not.toContain("refresh-token-secret");
    expect(JSON.stringify([...hiddenStore.records.keys()])).not.toContain(deviceRecord.deviceCode);

    await deleteGitHubDeviceAuthorizationRecord(requestId);
    await deleteGitHubOAuthRecord(profileId);
    expect(hiddenStore.records.size).toBe(0);
  });

  it("rejects an own __proto__ key in persisted provenance", async () => {
    const record = {
      ...deviceRecord,
      agentLifecycleBinding: {
        agentId: "main",
        provenance: {
          agentId: "main",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: now,
        },
      },
    };
    Object.defineProperty(record.agentLifecycleBinding.provenance, "__proto__", {
      value: null,
      enumerable: true,
    });
    hiddenStore.records.set(requestId, JSON.stringify(record));
    expect(await readGitHubDeviceAuthorizationRecord(requestId)).toBeUndefined();
  });

  it("preserves System record reads that discard an invalid agent binding", async () => {
    const agentLifecycleBinding = { agentId: "main", provenance: null, extra: true };
    const { agentLifecycleBinding: _binding, ...unboundDevice } = deviceRecord;
    const expected = { ...unboundDevice, scope: "system" };
    hiddenStore.records.set(requestId, JSON.stringify({ ...expected, agentLifecycleBinding }));
    expect(await readGitHubDeviceAuthorizationRecord(requestId)).toStrictEqual(expected);
    const pendingInitial = {
      requestId,
      scope: "system",
      agentId: "main",
      expectedIdentity: null,
    };
    hiddenStore.records.set(
      `github-oauth-${profileId.slice("ghp_".length)}`,
      JSON.stringify({
        ...oauthRecord,
        scope: "system",
        pendingInitial: { ...pendingInitial, agentLifecycleBinding },
      }),
    );
    expect(await inspectGitHubOAuthRecord(profileId)).toStrictEqual({
      state: "valid",
      record: { ...oauthRecord, scope: "system", pendingInitial },
    });
  });

  it.each([
    ["missing lifecycle binding", { agentLifecycleBinding: undefined }],
    ["foreign lifecycle agent", { agentLifecycleBinding: { agentId: "other", provenance: null } }],
    [
      "foreign provenance agent",
      {
        agentLifecycleBinding: {
          agentId: "main",
          provenance: {
            agentId: "other",
            createdVia: "operator",
            creatorAgentId: null,
            createdAtMs: now,
          },
        },
      },
    ],
    [
      "extra Git author field",
      { expectedIdentity: { profileId, gitAuthor: { name: "Name", extra: true } } },
    ],
    ["missing identity snapshot", { expectedIdentity: undefined }],
  ])("rejects a pending record with %s", async (_label, overrides) => {
    const value = structuredClone(deviceRecord);
    Object.assign(value, overrides);
    await expect(writeGitHubDeviceAuthorizationRecord(value)).rejects.toThrow();
  });

  it.each([
    [
      "pending-initial scope mismatch",
      {
        ...oauthRecord,
        pendingInitial: {
          requestId,
          scope: "system",
          agentId: "main",
          expectedIdentity: null,
        },
      },
    ],
    [
      "pending refresh with terminal failure",
      { ...oauthRecord, pendingRefresh: true, refreshFailure: "expired" },
    ],
  ])("rejects refresh metadata with %s", async (_label, value) => {
    const candidate = structuredClone(oauthRecord);
    Object.assign(candidate, value);
    await expect(writeGitHubOAuthRecord(candidate)).rejects.toThrow();
  });
});
