import { beforeEach, expect, it, vi } from "vitest";

const { records } = vi.hoisted(() => ({ records: new Map<string, string>() }));

// mock-isolation: OAuth record fixtures use an in-memory vault so tests cannot read or write real secrets.
vi.mock("../secrets/store/secret-store-hidden-github.js", () => ({
  deleteHiddenGitHubSecretRecord: ({ name }: { name: string }) => records.delete(name),
  listHiddenGitHubSecretRecords: ({ prefix }: { prefix: string }) =>
    [...records.entries()]
      .filter(([name]) => name.startsWith(`${prefix}-`))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value })),
  readHiddenGitHubSecretRecord: ({ name }: { name: string }) => records.get(name),
  writeHiddenGitHubSecretRecord: ({ name, value }: { name: string; value: string }) =>
    records.set(name, value),
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
const owner = { version: 1, agentId: "main", scope: "agent", createdAtMs: now } as const;
const oauthName = `github-oauth-${profileId.slice("ghp_".length)}`;
const binding = { agentId: "main", provenance: null };
const systemPending = { requestId, scope: "system", agentId: "main", expectedIdentity: null };
const provenance = (agentId = "main") => ({
  agentId,
  createdVia: "operator",
  creatorAgentId: null,
  createdAtMs: now,
});
const foreignBinding = { ...binding, provenance: provenance("other") };
function seed(name: string, record: unknown) {
  records.set(name, JSON.stringify(record));
}

const deviceRecord: GitHubDeviceAuthorizationRecord = {
  ...owner,
  requestId,
  deviceCode: "a".repeat(40),
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  expiresAtMs: now + 15 * 60_000,
  pollIntervalMs: 5_000,
  nextPollAtMs: now + 5_000,
  expectedIdentity: {
    profileId,
    allowInSandbox: true,
    gitAuthor: { name: "  Original Author  ", email: "  original@example.test  " },
  },
  agentLifecycleBinding: binding,
};

const oauthRecord: GitHubOAuthRecord = {
  ...owner,
  profileId,
  accountId: 3803641,
  login: "roboclaw-bot",
  refreshToken: "refresh-token-secret",
  accessExpiresAtMs: now + 8 * 60 * 60_000,
  refreshExpiresAtMs: now + 180 * 24 * 60 * 60_000,
  scopes: ["offline_access", "repo", "workflow"],
};

beforeEach(() => records.clear());

it("round-trips exact pending and refresh records under opaque hidden names", async () => {
  await writeGitHubDeviceAuthorizationRecord(deviceRecord);
  await writeGitHubOAuthRecord(oauthRecord);

  expect([...records.keys()]).toEqual([requestId, oauthName]);
  expect(await listGitHubDeviceAuthorizationRecords()).toEqual([
    { requestId, record: deviceRecord },
  ]);
  expect(await listGitHubOAuthRecords()).toEqual([{ profileId, record: oauthRecord }]);
  expect(await readGitHubDeviceAuthorizationRecord(requestId)).toEqual(deviceRecord);
  expect(await inspectGitHubOAuthRecord(profileId)).toEqual({
    state: "valid",
    record: oauthRecord,
  });

  await deleteGitHubDeviceAuthorizationRecord(requestId);
  await deleteGitHubOAuthRecord(profileId);
  expect(records.size).toBe(0);
});

it("rejects an own __proto__ key in persisted provenance", async () => {
  seed(requestId, {
    ...deviceRecord,
    // A computed key creates an own property instead of setting the prototype.
    agentLifecycleBinding: { ...binding, provenance: { ...provenance(), ["__proto__"]: null } },
  });
  expect(await readGitHubDeviceAuthorizationRecord(requestId)).toBeUndefined();
});

it("preserves System record reads that discard an invalid agent binding", async () => {
  const agentLifecycleBinding = { ...binding, extra: true };
  const { agentLifecycleBinding: _binding, ...unboundDevice } = deviceRecord;
  const expected = { ...unboundDevice, scope: "system" };
  seed(requestId, { ...expected, agentLifecycleBinding });
  expect(await readGitHubDeviceAuthorizationRecord(requestId)).toStrictEqual(expected);
  seed(oauthName, {
    ...oauthRecord,
    scope: "system",
    pendingInitial: { ...systemPending, agentLifecycleBinding },
  });
  expect(await inspectGitHubOAuthRecord(profileId)).toStrictEqual({
    state: "valid",
    record: { ...oauthRecord, scope: "system", pendingInitial: systemPending },
  });
});

it.each([
  ["missing lifecycle binding", { agentLifecycleBinding: undefined }],
  ["foreign lifecycle agent", { agentLifecycleBinding: { ...binding, agentId: "other" } }],
  ["foreign provenance agent", { agentLifecycleBinding: foreignBinding }],
  [
    "extra Git author field",
    { expectedIdentity: { profileId, gitAuthor: { name: "Name", extra: true } } },
  ],
  ["missing identity snapshot", { expectedIdentity: undefined }],
])("rejects a pending record with %s", async (_label, overrides) => {
  const value = Object.assign(structuredClone(deviceRecord), overrides);
  await expect(writeGitHubDeviceAuthorizationRecord(value)).rejects.toThrow();
});

it.each([
  ["pending-initial scope mismatch", { pendingInitial: systemPending }],
  ["pending refresh with terminal failure", { pendingRefresh: true, refreshFailure: "expired" }],
])("rejects refresh metadata with %s", async (_label, value) => {
  const candidate = Object.assign(structuredClone(oauthRecord), value);
  await expect(writeGitHubOAuthRecord(candidate)).rejects.toThrow();
});
