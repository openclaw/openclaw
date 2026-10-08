import { describe, expect, it, vi } from "vitest";
import {
  githubAsyncMergeReceiptRef,
  parseGitHubAsyncMergeReceipt,
  readGitHubAsyncMergeStatus,
  type GitHubAsyncMergeReceipt,
} from "../api.js";

const HEAD = "a".repeat(40);
const LANDED = "b".repeat(40);
const UUID = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
const TARGET = {
  owner: "octocat",
  repo: "example",
  number: 55,
  url: "https://github.com/octocat/example/pull/55",
  headSha: HEAD,
};

function retained(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    repo: {
      id: "repository-id",
      nameWithOwner: "octocat/example",
      url: "https://github.com/octocat/example",
    },
    pr: 55,
    head: HEAD,
    phase: "intent",
    accepted: true,
    transport: "rest",
    route: "immediate",
    method: "squash",
    asyncMerge: {
      uuid: UUID,
      status: "pending",
      message: "Merge request is in progress.",
      sha: null,
    },
    ...overrides,
  });
}

function pending(): GitHubAsyncMergeReceipt {
  const receipt = parseGitHubAsyncMergeReceipt(retained(), TARGET);
  if (!receipt) {
    throw new Error("Expected a valid native merge receipt");
  }
  return receipt;
}

function requestFixture(body: unknown, status = 200, headers?: HeadersInit) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status, headers }));
  const identity = {
    token: "synthetic-merge-credential",
    revalidate: vi.fn(async () => {}),
    assertSelected: vi.fn(),
  };
  return { fetchImpl, identity, apiBaseUrl: "https://api.github.com" };
}

function pendingResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    details: {
      uuid: UUID,
      expected_head_sha: HEAD,
      merge_method: "squash",
      merge_action: "direct_merge",
      bypass_rules: false,
      message: "Merge request is in progress.",
      ...overrides,
    },
  };
}

describe("native asynchronous merge receipts", () => {
  it("binds the accepted request to the discovered repository, PR, and head", () => {
    expect(githubAsyncMergeReceiptRef(TARGET.number)).toBe("refs/openclaw/pr-merge-outcomes/55");
    expect(pending()).toEqual({
      uuid: UUID,
      status: "pending",
      message: "Merge request is in progress.",
    });
    for (const target of [
      { ...TARGET, headSha: LANDED },
      { ...TARGET, number: 56 },
      { ...TARGET, owner: "another" },
      { ...TARGET, url: TARGET.url.replace("github.com", "ghe.example.test") },
    ]) {
      expect(parseGitHubAsyncMergeReceipt(retained(), target)).toBeNull();
    }
  });

  it.each([
    { version: 2 },
    { accepted: false },
    { route: "auto" },
    { transport: "graphql" },
    { method: "merge" },
    { asyncMerge: { uuid: "not-a-request", status: "pending", message: "", sha: null } },
    { asyncMerge: { uuid: UUID, status: "pending", message: "x".repeat(4097), sha: null } },
  ])("rejects malformed or unrelated retained state %j", (overrides) => {
    expect(parseGitHubAsyncMergeReceipt(retained(overrides), TARGET)).toBeNull();
  });

  it("does not turn an unacknowledged submission into active polling", () => {
    expect(
      parseGitHubAsyncMergeReceipt(
        retained({
          accepted: false,
          asyncMerge: { uuid: null, status: "submitting", message: "", sha: null },
        }),
        TARGET,
      ),
    ).toMatchObject({ uuid: null, status: "unavailable" });
    expect(parseGitHubAsyncMergeReceipt("{", TARGET)).toBeNull();
    expect(parseGitHubAsyncMergeReceipt(" ".repeat(65537), TARGET)).toBeNull();
  });

  it("uses the retained confirmation instead of polling an older pending acknowledgment", () => {
    expect(
      parseGitHubAsyncMergeReceipt(retained({ phase: "complete", landed: LANDED }), TARGET),
    ).toMatchObject({ uuid: null, status: "merged", sha: LANDED });
  });
});

describe("GitHub asynchronous merge status reads", () => {
  it("uses only the accepted UUID with the async API version and current credential", async () => {
    const options = requestFixture(pendingResponse());
    await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).resolves.toEqual({
      status: "pending",
      message: "Merge request is in progress.",
    });
    expect(options.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = options.fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/octocat/example/pulls/55/merge-async/${UUID}`);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("x-github-api-version")).toBe("2026-03-10");
    expect(new Headers(init?.headers).get("cache-control")).toBe("max-age=0");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${options.identity.token}`,
    );
  });

  it.each([
    { expected_head_sha: LANDED },
    { uuid: "11111111-1111-1111-1111-111111111111" },
    { merge_method: "merge" },
    { merge_action: "merge_queue" },
    { bypass_rules: true },
  ])("does not animate a request with changed binding %j", async (details) => {
    const options = requestFixture(pendingResponse(details));
    await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it.each(["merged", "enqueued", "failed"] as const)(
    "projects the terminal %s response",
    async (status) => {
      const options = requestFixture({
        status,
        details: { message: "Observed result", sha: LANDED },
      });
      await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).resolves.toEqual({
        status,
        message: "Observed result",
        ...(status === "merged" ? { sha: LANDED } : {}),
      });
    },
  );

  it.each([401, 403, 404, 500])(
    "keeps HTTP %s unavailable without anonymous retry or merge resubmission",
    async (status) => {
      const options = requestFixture({ message: "upstream diagnostic" }, status);
      const result = await readGitHubAsyncMergeStatus(TARGET, pending(), options);
      expect(result.status).toBe("unavailable");
      expect(result.message).not.toContain("expired");
      expect(result.message).not.toContain("upstream diagnostic");
      expect(options.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("retains the transport quota deadline", async () => {
    const options = requestFixture({}, 429, { "retry-after": "60" });
    const result = await readGitHubAsyncMergeStatus(TARGET, pending(), options);
    expect(result.status).toBe("unavailable");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("rejects a repository redirect without reading the replacement", async () => {
    const options = requestFixture({}, 301, {
      location: "https://api.github.com/repos/another/example/pulls/55/merge-async/" + UUID,
    });
    await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it("fences delivery after authority retires during the request", async () => {
    const options = requestFixture(pendingResponse());
    options.fetchImpl.mockImplementation(async () => {
      options.identity.assertSelected.mockImplementation(() => {
        throw new Error("Retired session");
      });
      return new Response(JSON.stringify(pendingResponse()));
    });
    await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).rejects.toThrow(
      "Retired session",
    );
  });

  it("bounds display messages and never echoes the selected credential", async () => {
    const options = requestFixture({ status: "failed", details: { message: "x".repeat(1000) } });
    expect((await readGitHubAsyncMergeStatus(TARGET, pending(), options)).message).toHaveLength(
      512,
    );
    options.fetchImpl.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            details: { message: options.identity.token },
          }),
        ),
    );
    await expect(readGitHubAsyncMergeStatus(TARGET, pending(), options)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("does not poll retained terminal outcomes", async () => {
    const options = requestFixture({});
    const receipt = { uuid: null, status: "enqueued" as const, message: "In the merge queue" };
    await expect(readGitHubAsyncMergeStatus(TARGET, receipt, options)).resolves.toEqual({
      status: "enqueued",
      message: "In the merge queue",
    });
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
});
