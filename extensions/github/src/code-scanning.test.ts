import { expect, it } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import { managedIdentity, previewFetch } from "./preview.test-support.js";
import { parseGitHubReadParams } from "./targets.js";
import type { GitHubCodeScanningTarget } from "./targets.js";

it("accepts the protected analysis URL needed to diagnose a failed PR scan", () => {
  expect(
    parseGitHubReadParams({
      url: "https://api.github.com/repos/octocat/reader/code-scanning/analyses?ref=refs%2Fpull%2F42%2Fmerge",
    }),
  ).toEqual({
    target: {
      kind: "code-scanning",
      owner: "octocat",
      repo: "reader",
      operation: "analyses",
      ref: "refs/pull/42/merge",
      page: 1,
    },
    refresh: false,
  });
});

const repository = "https://api.github.com/repos/octocat/reader";
const target: GitHubCodeScanningTarget = {
  kind: "code-scanning",
  owner: "octocat",
  repo: "reader",
  operation: "analysis",
  analysisId: 7,
};
const account = { accountId: 123, source: "agent-override" } as const;
const analysis = {
  id: 7,
  commit_sha: "a".repeat(40),
  category: "security",
  error: "Upload processing failed",
  warning: "",
  results_count: 0,
};
function fixture(value: unknown = analysis) {
  let current = true;
  const identity = {
    ...managedIdentity("diagnostics", () => {
      if (!current) {
        throw new Error("reader changed");
      }
    }),
    readerAccount: account,
  };
  const fetcher = previewFetch((url) =>
    url === repository
      ? Response.json({ id: 123, private: false, visibility: "public" })
      : Response.json(value),
  );
  return {
    identity,
    fetcher,
    revoke: () => {
      current = false;
    },
  };
}

it.each([
  "https://api.github.com/repos/octocat/reader/code-scanning/analyses",
  "https://api.github.com/repos/octocat/reader/code-scanning/analyses?ref=main&ref=other",
  "https://api.github.com/repos/octocat/reader/code-scanning/analyses?ref=main&page=51",
  "https://api.github.com/repos/octocat/reader/actions/runs/1/rerun",
  "https://api.github.com/repos/octocat/reader/code-scanning/sarifs/not-an-id",
  "https://api.github.com/repos/octocat/reader/code-scanning/analyses/7?raw=true",
])("rejects an unsupported diagnostic URL: %s", (url) => {
  expect(parseGitHubReadParams({ url })).toBeNull();
});

it("reads protected metadata with the selected account and omits source payloads and credentials", async () => {
  const f = fixture({
    ...analysis,
    warning: "token-diagnostics",
    source: "unrequested SARIF source",
  });
  const result = await loadGitHubDetail(target, f.identity, f.fetcher);
  expect(JSON.parse(result.body)).toEqual({ ...analysis, warning: "[REDACTED]" });
  expect(result.metadata).toEqual([
    { label: "Reader account ID", value: "123" },
    { label: "Reader source", value: "agent-override" },
  ]);
  for (const [, init] of f.fetcher.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-diagnostics");
  }
  expect(result.partial).toBe(false);
});

it("does not borrow a service credential or retry an anonymous protected read", async () => {
  const f = fixture();
  for (const identity of [
    undefined,
    managedIdentity("ambient"),
    { ...f.identity, optionalAuth: true as const },
  ]) {
    await expect(loadGitHubDetail(target, identity, f.fetcher)).rejects.toThrow(
      "managed GitHub identity",
    );
  }
  expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher
    .mockResolvedValueOnce(Response.json({ id: 123, private: false, visibility: "public" }))
    .mockResolvedValueOnce(Response.json({ message: "access denied" }, { status: 403 }));
  await expect(loadGitHubDetail(target, f.identity, f.fetcher)).rejects.toThrow("HTTP 403");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it("withholds protected output if the reader changes while the response arrives", async () => {
  const f = fixture();
  f.fetcher
    .mockResolvedValueOnce(Response.json({ id: 123, private: false, visibility: "public" }))
    .mockImplementationOnce(async () => {
      f.revoke();
      return Response.json(analysis);
    });
  await expect(loadGitHubDetail(target, f.identity, f.fetcher)).rejects.toThrow("reader changed");
});

it("returns bounded analysis pages and a reusable next-page URL", async () => {
  const f = fixture(Array.from({ length: 30 }, (_, i) => ({ ...analysis, id: i + 1 })));
  const result = await loadGitHubDetail(
    { ...target, operation: "analyses", ref: "refs/pull/42/merge", page: 1 },
    f.identity,
    f.fetcher,
  );
  expect(JSON.parse(result.body)).toMatchObject({ nextPage: 2, limited: false });
  expect(result.partial).toBe(true);
  expect(parseGitHubReadParams({ url: result.url })).not.toBeNull();
});

it("exposes SARIF processing errors without claiming the upload was an analysis finding", async () => {
  const f = fixture({
    processing_status: "failed",
    errors: ["Invalid upload"],
    analyses_url: "unrequested",
  });
  const sarifId = "11111111-2222-3333-4444-555555555555";
  const parsed = parseGitHubReadParams({ url: `${repository}/code-scanning/sarifs/${sarifId}` });
  expect(parsed?.target).toEqual({
    kind: "code-scanning",
    owner: "octocat",
    repo: "reader",
    operation: "sarif",
    sarifId,
  });
  const result = await loadGitHubDetail(
    { ...target, operation: "sarif", sarifId },
    f.identity,
    f.fetcher,
  );
  expect(JSON.parse(result.body)).toEqual({
    sarifId,
    processingStatus: "failed",
    errors: ["Invalid upload"],
  });
});
