import { describe, expect, it } from "vitest";
import type { GitHubOAuthRecord } from "./github-oauth-records.js";
import { resolveGitHubPublicationAccessExpiry } from "./github-tool-identity-lifecycle.js";

const record: GitHubOAuthRecord = {
  version: 1,
  profileId: "ghp_11111111111111111111111111111111",
  agentId: "main",
  scope: "system",
  accountId: 42,
  login: "fixture",
  refreshToken: "synthetic-refresh",
  scopes: [],
  accessExpiresAtMs: 1000,
  refreshExpiresAtMs: 2000,
  createdAtMs: 0,
};

describe("publication credential expiry affinity", () => {
  it("carries the expiry only for the same settled credential record", () => {
    expect(
      resolveGitHubPublicationAccessExpiry(
        { state: "valid", record },
        { state: "valid", record },
        42,
      ),
    ).toBe(1000);
    for (const replacement of [
      { ...record, refreshToken: "synthetic-replacement" },
      { ...record, pendingRefresh: true as const },
      { ...record, accountId: 43 },
    ]) {
      expect(
        resolveGitHubPublicationAccessExpiry(
          { state: "valid", record },
          { state: "valid", record: replacement },
          42,
        ),
      ).toBeUndefined();
    }
    expect(
      resolveGitHubPublicationAccessExpiry(undefined, { state: "valid", record }, 42),
    ).toBeUndefined();
  });
});
