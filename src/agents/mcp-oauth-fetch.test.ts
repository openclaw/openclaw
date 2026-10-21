import type { FetchLike } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";

const oauthMocks = vi.hoisted(() => ({
  recordAuthorizationRequired: vi.fn(),
  resolve: vi.fn(),
}));
const IDENTITY = operatorMcpOAuthIdentity("docs", "https://mcp.example.com/mcp");

vi.mock("./mcp-oauth.js", () =>
  Object.fromEntries([
    ["recordMcpOAuthAuthorizationRequired", oauthMocks.recordAuthorizationRequired],
    ["resolveMcpOAuthAccessToken", oauthMocks.resolve],
  ]),
);

function bearer(headers: HeadersInit | undefined): string | null {
  return new Headers(headers).get("authorization")?.replace(/^Bearer /u, "") ?? null;
}

function callHeaders(fetchFn: ReturnType<typeof vi.fn<FetchLike>>, index: number): HeadersInit {
  const call = fetchFn.mock.calls[index];
  const input = call?.[0];
  return input instanceof Request ? input.headers : (call?.[1]?.headers ?? {});
}

function wrap(fetchFn: ReturnType<typeof vi.fn<FetchLike>>) {
  return withMcpOAuthBearer({ fetchFn, authFetchFn: fetchFn, identity: IDENTITY });
}

function expectBearers(fetchFn: ReturnType<typeof vi.fn<FetchLike>>, tokens: (string | null)[]) {
  expect(tokens.map((_, index) => bearer(callHeaders(fetchFn, index)))).toEqual(tokens);
}

function makeResponse(status = 200, challenge?: string) {
  return new Response("fixture", {
    status,
    headers: challenge ? { "www-authenticate": challenge } : undefined,
  });
}

describe("MCP OAuth bearer fetch", () => {
  beforeEach(() => {
    oauthMocks.recordAuthorizationRequired.mockReset();
    oauthMocks.resolve.mockReset();
  });

  it("injects native OAuth only at the configured resource origin", async () => {
    oauthMocks.resolve.mockResolvedValue("test-token-placeholder");
    const fetchFn = vi.fn<FetchLike>(async () => makeResponse());
    const wrapped = wrap(fetchFn);

    await wrapped("https://mcp.example.com/mcp", { headers: { "x-tenant": "docs" } });
    await wrapped("https://auth.example.com/token");

    expect(oauthMocks.resolve).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve.mock.calls[0]?.[0]).toMatchObject({ acceptUnknownExpiry: true });
    expectBearers(fetchFn, ["test-token-placeholder", null]);
  });

  it("uses an unauthenticated challenge to bootstrap a missing token", async () => {
    oauthMocks.resolve.mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-auth-token");
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        makeResponse(
          401,
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="docs.read"',
        ),
      )
      .mockResolvedValueOnce(makeResponse());
    const wrapped = wrap(fetchFn);

    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 200 });
    expectBearers(fetchFn, [null, "test-auth-token"]);
    expect(oauthMocks.resolve.mock.calls[0]?.[0]).toMatchObject({ allowMissingToken: true });
    expect(oauthMocks.resolve.mock.calls[1]?.[0]).toMatchObject({
      authorizationChallenge: true,
      resourceMetadataUrl: new URL("https://mcp.example.com/.well-known/oauth-protected-resource"),
      scope: "docs.read",
    });
  });

  it("replays a body-bearing Request once after OAuth refresh", async () => {
    oauthMocks.resolve
      .mockResolvedValueOnce("decoy-token")
      .mockResolvedValueOnce("test-auth-token");
    const bodies: string[] = [];
    const fetchFn = vi.fn<FetchLike>(async (input, init) => {
      expect(init).not.toBeInstanceOf(Request);
      bodies.push(await new Request(input, init).text());
      return makeResponse(bodies.length === 1 ? 401 : 200);
    });
    const wrapped = wrap(fetchFn);

    const response = await wrapped(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","method":"tools/list"}',
      }),
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      '{"jsonrpc":"2.0","method":"tools/list"}',
      '{"jsonrpc":"2.0","method":"tools/list"}',
    ]);
    expectBearers(fetchFn, ["decoy-token", "test-auth-token"]);
  });

  it("requires scope-bearing login on insufficient-scope 403 but leaves other 403s untouched", async () => {
    const loginRequired = new Error("additional OAuth authorization required");
    oauthMocks.resolve.mockResolvedValueOnce("decoy-token").mockRejectedValueOnce(loginRequired);
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        makeResponse(403, 'Bearer error="insufficient_scope", scope="docs.write"'),
      );
    const wrapped = wrap(fetchFn);

    await expect(wrapped("https://mcp.example.com/mcp")).rejects.toBe(loginRequired);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve.mock.calls[1]?.[0]).toMatchObject({
      interactiveAuthorizationRequired: true,
      scope: "docs.write",
    });

    oauthMocks.resolve.mockReset().mockResolvedValue("test-token-placeholder");
    fetchFn.mockReset().mockResolvedValue(makeResponse(403));
    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 403 });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve).toHaveBeenCalledOnce();
  });

  it("returns the second rejection without an unbounded auth loop", async () => {
    oauthMocks.resolve
      .mockResolvedValueOnce("decoy-token")
      .mockResolvedValueOnce("test-auth-token");
    const fetchFn = vi.fn<FetchLike>(async () => makeResponse(401));
    const wrapped = wrap(fetchFn);

    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(oauthMocks.resolve).toHaveBeenCalledTimes(2);
    expect(oauthMocks.recordAuthorizationRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: IDENTITY,
        rejectedAccessToken: "test-auth-token",
      }),
    );
  });
});
