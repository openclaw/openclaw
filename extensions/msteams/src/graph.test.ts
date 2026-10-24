import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const {
  loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProviderMock,
  fetchWithSsrFGuardMock,
  resolveDelegatedAccessTokenMock,
  resolveMSTeamsCredentialsMock,
} = vi.hoisted(() => ({
  loadMSTeamsSdkWithAuthMock: vi.fn(),
  createMSTeamsTokenProviderMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(
    async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => ({
      response: await globalThis.fetch(params.url, params.init),
      finalUrl: params.url,
      release: async () => undefined,
    }),
  ),
  resolveDelegatedAccessTokenMock: vi.fn(),
  resolveMSTeamsCredentialsMock: vi.fn(),
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProvider: createMSTeamsTokenProviderMock,
}));

vi.mock("./token-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-config.js")>()),
  hasConfiguredMSTeamsCredentials: () => false,
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

vi.mock("./token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token.js")>()),
  resolveDelegatedAccessToken: resolveDelegatedAccessTokenMock,
}));

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { fetchChannelMessage, fetchThreadReplies } from "./graph-thread.js";
import { findGraphUsersByExactIdentity, searchGraphUsers } from "./graph-users.js";
import {
  deleteGraphRequest,
  fetchAllGraphPages,
  fetchGraphAbsoluteUrl,
  fetchGraphJson,
  listChannelsForTeamWithPageInfo,
  listTeamsByNameWithPageInfo,
  mutateGraphJson,
  resolveGraphToken,
} from "./graph.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

const originalFetch = globalThis.fetch;
const graphToken = "graph-token";
const mockCredentials = {
  type: "secret",
  appId: "app-id",
  appPassword: "app-password",
  tenantId: "tenant-id",
};
const mockApp = { id: "mock-app" };
const groupOne = { id: "group-1" };
const opsTeam = { id: "team-1", displayName: "Ops" };
const deploymentsChannel = { id: "chan-1", displayName: "Deployments" };
const userOne = { id: "user-1", displayName: "User One" };
const bobUser = { id: "user-2", displayName: "Bob" };

function mockFetch(handler: Parameters<typeof vi.fn>[0]) {
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
}

function mockJsonFetchResponse(...bodies: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const body of bodies) {
    fetch.mockResolvedValueOnce(Response.json(body));
  }
  globalThis.fetch = fetch;
}

function mockTextFetchResponse(body: string, init?: ResponseInit) {
  mockFetch(async () => new Response(body, init));
}

function graphStreamResponse(body: unknown): {
  response: Response;
  arrayBuffer: ReturnType<typeof vi.fn>;
} {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const response = new Response(new Blob([encoded]).stream(), {
    headers: { "content-type": "application/json" },
  });
  const arrayBuffer = vi.spyOn(response, "arrayBuffer").mockImplementation(async () => {
    throw new Error("Graph response must stay streaming");
  });
  return { response, arrayBuffer };
}

function graphCollection<T>(...items: T[]) {
  return { value: items };
}

function mockGraphCollection(...items: unknown[]) {
  mockJsonFetchResponse(graphCollection(...items));
}

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : String(input);
}

function fetchCallUrl(index: number) {
  return requestUrl(vi.mocked(globalThis.fetch).mock.calls[index]?.[0] ?? "");
}

function fetchCallInit(index: number) {
  return vi.mocked(globalThis.fetch).mock.calls[index]?.[1];
}

function fetchCallHeader(index: number, name: string) {
  return new Headers(fetchCallInit(index)?.headers).get(name);
}

function fetchCallSearchParam(index: number, name: string): string | null {
  return new URL(fetchCallUrl(index)).searchParams.get(name);
}

async function expectSearchGraphUsers(
  query: string,
  expected: Array<Record<string, unknown>>,
  options?: { token?: string; top?: number },
) {
  await expect(searchGraphUsers({ token: graphToken, query, ...options })).resolves.toEqual(
    expected,
  );
}

function mockGraphTokenResolution(token = "resolved-token") {
  const getAccessToken = vi.fn(async () => token);
  loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: mockApp });
  createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
  resolveMSTeamsCredentialsMock.mockReturnValue(mockCredentials);
  return { getAccessToken };
}

function tokenConfig(
  msteams: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]> = {},
) {
  return { channels: { msteams } };
}

function accountCredentials(name: string) {
  return {
    appId: `${name}-app`,
    appPassword: `${name}-password`,
    tenantId: "tenant-id",
    webhook: { path: "/api/messages/named" },
  };
}

function readGraph(path = "/groups?$select=id", headers?: Record<string, string>) {
  return fetchGraphJson({ token: graphToken, path, headers });
}

describe("msteams graph helpers", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("keeps channel parent and reply requests within their Graph query contracts", async () => {
    const parent = { id: "parent-1", body: { content: "Original question" } };
    const reply = { id: "reply-1", body: { content: "Earlier decision" } };
    mockFetch(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      const isReplies = url.pathname.endsWith("/replies");
      const unsupported = [...url.searchParams.keys()].filter(
        (parameter) => !isReplies || parameter !== "$top",
      );
      return Response.json(
        unsupported.length > 0
          ? { error: { code: "BadRequest", message: "Unsupported query parameter" } }
          : isReplies
            ? graphCollection(reply)
            : parent,
        unsupported.length > 0 ? { status: 400 } : undefined,
      );
    });

    const outcomes = await Promise.allSettled([
      fetchChannelMessage(graphToken, "group-1", "channel-1", "parent-1"),
      fetchThreadReplies(graphToken, "group-1", "channel-1", "parent-1"),
    ]);

    expect(outcomes).toEqual([
      { status: "fulfilled", value: parent },
      { status: "fulfilled", value: [reply] },
    ]);
    expect(fetchCallSearchParam(0, "$select")).toBeNull();
    expect(fetchCallSearchParam(1, "$select")).toBeNull();
    expect(fetchCallSearchParam(1, "$top")).toBe("50");
  });

  it("lets the shared SSRF guard select the Graph transport", async () => {
    mockGraphCollection();

    await fetchGraphJson({
      token: graphToken,
      path: "/groups",
    });

    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).not.toHaveProperty("fetchImpl");
  });

  it("fetches Graph JSON and surfaces Graph errors with response text", async () => {
    mockGraphCollection(groupOne);

    await expect(
      readGraph("/groups?$select=id", { ConsistencyLevel: "eventual" }),
    ).resolves.toEqual(graphCollection(groupOne));

    expect(fetchCallUrl(0)).toBe("https://graph.microsoft.com/v1.0/groups?$select=id");
    expect(fetchCallHeader(0, "Authorization")).toBe(`Bearer ${graphToken}`);
    expect(fetchCallHeader(0, "ConsistencyLevel")).toBe("eventual");
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ timeoutMs: 30_000 }),
    );

    mockTextFetchResponse("forbidden", { status: 403 });

    await expect(readGraph("/teams/team-1/channels")).rejects.toThrow(
      "Graph /teams/team-1/channels failed (403): forbidden",
    );

    mockTextFetchResponse("{ nope", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(readGraph("/teams/team-1/channels")).rejects.toThrow(
      "Graph /teams/team-1/channels failed: malformed JSON response",
    );
  });

  it("keeps successful Graph responses streaming for bounded JSON parsing", async () => {
    const { response, arrayBuffer } = graphStreamResponse(graphCollection(groupOne));
    mockFetch(async () => response);

    await expect(readGraph()).resolves.toEqual(graphCollection(groupOne));

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("passes the remaining operation deadline to the guarded Graph transport", async () => {
    mockGraphCollection(groupOne);
    const remainingMs = 5_000;

    await fetchGraphJson({
      token: graphToken,
      path: "/groups?$select=id",
      deadline: {
        label: "MS Teams inbound preprocessing",
        timeoutMs: remainingMs,
        deadlineAtMs: Date.now() + remainingMs,
      },
    });

    const timeoutMs = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.timeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(remainingMs);
  });

  it("bounds absolute Graph pagination requests", async () => {
    mockGraphCollection(groupOne);

    await fetchGraphAbsoluteUrl({
      token: graphToken,
      url: "https://graph.microsoft.com/v1.0/groups?$skiptoken=next",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("mutates Graph JSON at v1 and beta roots and treats empty responses as undefined", async () => {
    mockFetch(async (input, init) => {
      if (requestUrl(input).startsWith("https://graph.microsoft.com/beta")) {
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PATCH") {
        return new Response(null, { headers: { "content-length": "0" } });
      }
      return Response.json({ id: "created-1" });
    });

    const requests = [
      ["/chats/chat-1/pinnedMessages", "POST", { messageId: "msg-1" }, false, { id: "created-1" }],
      [
        "/chats/chat-1/messages/msg-1/setReaction",
        "POST",
        { reactionType: "like" },
        true,
        undefined,
      ],
      ["/chats/chat-1", "PATCH", { topic: "New topic" }, false, undefined],
    ] as const;
    for (const [index, [path, method, body, beta, result]] of requests.entries()) {
      await expect(
        mutateGraphJson({ token: graphToken, path, method, body, beta }),
      ).resolves.toEqual(result);
      expect(fetchCallUrl(index)).toBe(
        `https://graph.microsoft.com/${beta ? "beta" : "v1.0"}${path}`,
      );
      expect(fetchCallInit(index)).toMatchObject({ method, body: JSON.stringify(body) });
    }
    expect(fetchCallHeader(0, "Authorization")).toBe(`Bearer ${graphToken}`);
    expect(fetchCallHeader(0, "Content-Type")).toBe("application/json");
  });

  it("surfaces POST and DELETE graph failures with method-specific labels", async () => {
    mockFetch(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        return new Response("not found", { status: 404 });
      }
      return new Response("denied", { status: 403 });
    });

    const target = { token: graphToken, path: "/teams/team-1/channels" };
    await expect(
      mutateGraphJson({ ...target, method: "POST", body: { displayName: "Deployments" } }),
    ).rejects.toThrow("Graph POST /teams/team-1/channels failed (403): denied");
    await expect(
      deleteGraphRequest({ ...target, path: `${target.path}/channel-1` }),
    ).rejects.toThrow("Graph DELETE /teams/team-1/channels/channel-1 failed (404): not found");
  });

  it("releases a successful bodyful DELETE response", async () => {
    const upstreamCancel = vi.fn();
    const release = vi.fn(async () => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("deleted"));
        },
        cancel: upstreamCancel,
      }),
    );
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      finalUrl: "https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1",
      release,
    });

    await deleteGraphRequest({
      token: graphToken,
      path: "/chats/chat-1/messages/msg-1",
    });

    expect(upstreamCancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled SDK token acquisition", async () => {
    const { getAccessToken } = mockGraphTokenResolution();
    getAccessToken.mockImplementation(() => new Promise<string>(() => {}));
    vi.useFakeTimers();

    const result = resolveGraphToken(tokenConfig());
    const rejection = expect(result).rejects.toThrow(
      `MS Teams Graph token timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("resolves Graph credentials from the named Teams account", async () => {
    const { getAccessToken } = mockGraphTokenResolution();

    await expect(
      resolveGraphToken(
        tokenConfig({
          ...accountCredentials("root"),
          tenantId: "root-tenant",
          accounts: {
            secondary: { ...accountCredentials("secondary"), tenantId: "secondary-tenant" },
          },
        }),
        { accountId: "secondary" },
      ),
    ).resolves.toBe("resolved-token");

    expect(resolveMSTeamsCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "secondary-app",
        appPassword: "secondary-password",
        tenantId: "secondary-tenant",
      }),
      expect.objectContaining({
        allowEnvFallback: false,
        pathPrefix: "channels.msteams.accounts.secondary",
      }),
    );
    expect(createMSTeamsTokenProviderMock).toHaveBeenCalledWith(mockApp);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("rejects a disabled named account without blocking an enabled sibling", async () => {
    const { getAccessToken } = mockGraphTokenResolution();
    const cfg = tokenConfig({
      accounts: {
        disabled: { ...accountCredentials("disabled"), enabled: false },
        active: { ...accountCredentials("active"), enabled: true },
      },
    });

    await expect(resolveGraphToken(cfg, { accountId: "disabled" })).rejects.toThrow(
      "MS Teams account disabled: disabled",
    );
    await expect(resolveGraphToken(cfg, { accountId: "active" })).resolves.toBe("resolved-token");

    expect(loadMSTeamsSdkWithAuthMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ enabled: false }, "MS Teams account disabled: default"],
    [
      { cloud: "China" },
      "Microsoft Teams Graph operations are not supported for channels.msteams.cloud=China",
    ],
  ] as const)("rejects unavailable account %j before loading the SDK", async (config, error) => {
    mockGraphTokenResolution();
    await expect(resolveGraphToken(tokenConfig(config))).rejects.toThrow(error);
    expect(loadMSTeamsSdkWithAuthMock).not.toHaveBeenCalled();
  });

  it("scopes delegated Graph token lookup by account", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(mockCredentials);
    resolveDelegatedAccessTokenMock.mockResolvedValue("delegated-token");

    await expect(
      resolveGraphToken(tokenConfig({ delegatedAuth: { enabled: true } }), {
        accountId: "secondary",
        preferDelegated: true,
      }),
    ).resolves.toBe("delegated-token");

    expect(resolveDelegatedAccessTokenMock).toHaveBeenCalledWith({
      tenantId: "tenant-id",
      clientId: "app-id",
      clientSecret: "app-password",
      accountId: "secondary",
    });
    expect(loadMSTeamsSdkWithAuthMock).not.toHaveBeenCalled();
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expect(resolveGraphToken({ channels: {} })).rejects.toThrow(
      "MS Teams credentials missing",
    );

    mockGraphTokenResolution("");

    await expect(resolveGraphToken(tokenConfig())).rejects.toThrow(
      "MS Teams graph token unavailable",
    );
  });

  it("builds encoded Graph paths for teams and channels", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("/groups?")) {
        return Response.json(graphCollection(opsTeam));
      }
      return Response.json(graphCollection(deploymentsChannel));
    });

    await expect(listTeamsByNameWithPageInfo(graphToken, "Bob's Team")).resolves.toEqual({
      items: [opsTeam],
      truncated: false,
    });
    await expect(listChannelsForTeamWithPageInfo(graphToken, "team/ops")).resolves.toEqual({
      items: [deploymentsChannel],
      truncated: false,
    });

    expect(fetchCallSearchParam(0, "$filter")).toBe(
      "resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'Bob''s Team')",
    );
    expect(fetchCallSearchParam(0, "$select")).toBe("id,displayName");
    expect(fetchCallUrl(1)).toContain("/teams/team%2Fops/channels?$select=id,displayName");
  });

  it("exposes pagination completeness for authorization lookups", async () => {
    mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/groups?$skip=1")) {
        return Response.json(graphCollection({ id: "team-2", displayName: "Ops" }));
      }
      if (url.includes("/groups?")) {
        return Response.json({
          value: [opsTeam],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/groups?$skip=1",
        });
      }
      if (url.includes("/channels?$skip=1")) {
        return Response.json(graphCollection({ id: "channel-2", displayName: "Incidents" }));
      }
      return Response.json({
        value: [deploymentsChannel],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/team-1/channels?$skip=1",
      });
    });

    await expect(listTeamsByNameWithPageInfo(graphToken, "Ops")).resolves.toEqual({
      items: [opsTeam, { id: "team-2", displayName: "Ops" }],
      truncated: false,
    });
    await expect(listChannelsForTeamWithPageInfo(graphToken, "team-1")).resolves.toEqual({
      items: [deploymentsChannel, { id: "channel-2", displayName: "Incidents" }],
      truncated: false,
    });
  });

  it("builds an exact identity filter for authorization user lookup", async () => {
    mockGraphCollection(userOne);

    await expect(
      findGraphUsersByExactIdentity({ token: graphToken, query: "Alice O'Hara" }),
    ).resolves.toEqual({ items: [userOne], truncated: false });
    expect(fetchCallSearchParam(0, "$filter")).toBe(
      "(displayName eq 'Alice O''Hara' or mail eq 'Alice O''Hara' or userPrincipalName eq 'Alice O''Hara')",
    );
  });

  it("returns no graph users for blank queries", async () => {
    mockJsonFetchResponse({});
    await expectSearchGraphUsers("   ", [], { token: "token-1" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses exact mail or UPN lookup for email-like graph user queries", async () => {
    mockGraphCollection(userOne);

    await expectSearchGraphUsers("alice.o'hara@example.com", [userOne], { token: "token-2" });
    expect(fetchCallSearchParam(0, "$filter")).toBe(
      "(mail eq 'alice.o''hara@example.com' or userPrincipalName eq 'alice.o''hara@example.com')",
    );
    expect(fetchCallSearchParam(0, "$select")).toBe("id,displayName,mail,userPrincipalName");
  });

  it("uses displayName search with eventual consistency and default top handling", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("displayName%3Abob")) {
        return Response.json(graphCollection(bobUser));
      }
      return Response.json({});
    });

    await expectSearchGraphUsers("bob", [bobUser], { token: "token-3", top: 25 });
    await expectSearchGraphUsers("carol", [], { token: "token-4" });

    expect(fetchCallUrl(0)).toContain(
      "/users?$search=%22displayName%3Abob%22&$select=id,displayName,mail,userPrincipalName&$top=25",
    );
    expect(fetchCallHeader(0, "ConsistencyLevel")).toBe("eventual");
    expect(fetchCallUrl(1)).toContain(
      "/users?$search=%22displayName%3Acarol%22&$select=id,displayName,mail,userPrincipalName&$top=10",
    );
  });

  describe("fetchAllGraphPages", () => {
    type Item = { id: string };
    const repliesPage2 =
      "https://graph.microsoft.com/v1.0/teams/group/channels/channel/messages/root/replies?$skiptoken=page2";

    function pagedResponse(items: Item[], nextLink?: string) {
      return { value: items, ...(nextLink ? { "@odata.nextLink": nextLink } : {}) };
    }

    it("fetches the newest Teams thread replies across pages", async () => {
      const replies = Array.from({ length: 60 }, (_, index) => ({
        id: `reply-${index + 1}`,
        createdDateTime: `2026-08-01T00:${String(index).padStart(2, "0")}:00Z`,
      }));
      mockJsonFetchResponse(
        pagedResponse(replies.slice(0, 50).toReversed(), repliesPage2),
        pagedResponse(replies.slice(50).toReversed()),
      );

      const result = await fetchThreadReplies("tok", "group", "channel", "root");

      expect(result).toHaveLength(50);
      expect(result[0]?.id).toBe("reply-11");
      expect(result.at(-1)?.id).toBe("reply-60");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(fetchCallUrl(1)).toContain(
        "/teams/group/channels/channel/messages/root/replies?$skiptoken=page2",
      );
    });

    it("forwards the shared deadline to every paginated request", async () => {
      const deadline = {
        label: "MS Teams inbound preprocessing",
        timeoutMs: 10_000,
        deadlineAtMs: Date.now() + 10_000,
      };
      mockJsonFetchResponse(
        pagedResponse([{ id: "reply-1" }], repliesPage2),
        pagedResponse([{ id: "reply-2" }]),
      );

      await fetchThreadReplies("tok", "group", "channel", "root", deadline);

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
      for (const [params] of fetchWithSsrFGuardMock.mock.calls) {
        expect(params.timeoutMs).toBeGreaterThan(0);
        expect(params.timeoutMs).toBeLessThanOrEqual(10_000);
      }
    });

    it.each([undefined, false])("findOne early exit (collectItems=%s)", async (collectItems) => {
      const target = { id: "target" };
      const afterTarget = { id: "after" };
      const visited: string[] = [];
      mockJsonFetchResponse(
        pagedResponse([{ id: "1" }], "https://graph.microsoft.com/v1.0/items?$skiptoken=p2"),
        pagedResponse(
          [{ id: "2" }, target, afterTarget],
          "https://graph.microsoft.com/v1.0/items?$skiptoken=p3",
        ),
      );

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        maxPages: 2,
        collectItems,
        findOne: (item) => {
          visited.push(item.id);
          return item.id === "target";
        },
      });

      expect(result.found).toEqual(target);
      expect(result.truncated).toBe(false);
      expect(visited).toEqual(["1", "2", "target"]);
      expect(result.items).toEqual(
        collectItems === false ? [] : [{ id: "1" }, { id: "2" }, target, afterTarget],
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, false])("findOne with no match (collectItems=%s)", async (collectItems) => {
      mockFetch(async () =>
        Response.json(
          pagedResponse([{ id: "x" }], "https://graph.microsoft.com/v1.0/items?$skiptoken=more"),
        ),
      );

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        maxPages: 2,
        collectItems,
        findOne: (item) => item.id === "missing",
      });

      expect(result.found).toBeUndefined();
      expect(result.truncated).toBe(true);
      expect(result.items).toHaveLength(collectItems === false ? 0 : 2);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("preserves findOne errors", async () => {
      const failure = new Error("predicate failed");
      mockJsonFetchResponse(
        pagedResponse([{ id: "1" }], "https://graph.microsoft.com/v1.0/items?$skiptoken=p2"),
      );

      await expect(
        fetchAllGraphPages<Item>({
          token: graphToken,
          path: "/items",
          findOne: () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("treats a missing value as empty and rejects a malformed value", async () => {
      mockJsonFetchResponse({});
      await expect(
        fetchAllGraphPages<Item>({ token: graphToken, path: "/items" }),
      ).resolves.toEqual({ items: [], truncated: false });

      mockJsonFetchResponse({ value: { id: "not-an-array" } });
      await expect(
        fetchAllGraphPages<Item>({ token: graphToken, path: "/items" }),
      ).rejects.toThrow();
    });

    it("does not truncate when the final allowed page has no nextLink", async () => {
      mockFetch(async (_input, _init) =>
        vi.mocked(globalThis.fetch).mock.calls.length === 1
          ? Response.json(
              pagedResponse(
                [{ id: "1" }],
                "https://graph.microsoft.com/v1.0/items?$skiptoken=page2",
              ),
            )
          : Response.json(pagedResponse([{ id: "2" }])),
      );

      await expect(
        fetchAllGraphPages<Item>({ token: graphToken, path: "/items", maxPages: 2 }),
      ).resolves.toEqual({
        items: [{ id: "1" }, { id: "2" }],
        truncated: false,
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
