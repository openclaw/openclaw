import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProviderMock,
  readAccessTokenMock,
  resolveMSTeamsCredentialsMock,
} = vi.hoisted(() => {
  return {
    loadMSTeamsSdkWithAuthMock: vi.fn(),
    createMSTeamsTokenProviderMock: vi.fn(),
    readAccessTokenMock: vi.fn(),
    resolveMSTeamsCredentialsMock: vi.fn(),
  };
});

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProvider: createMSTeamsTokenProviderMock,
}));

vi.mock("./token-response.js", () => ({
  readAccessToken: readAccessTokenMock,
}));

vi.mock("./token.js", () => ({
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

import {
  escapeOData,
  fetchGraphJson,
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken,
  stripHtmlTags,
} from "./graph.js";

const originalFetch = globalThis.fetch;

describe("msteams graph helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes queries and escapes OData apostrophes", () => {
    expect(normalizeQuery("  Team Alpha  ")).toBe("Team Alpha");
    expect(normalizeQuery("   ")).toBe("");
    expect(escapeOData("alice.o'hara")).toBe("alice.o''hara");
  });

  it("fetches Graph JSON and surfaces Graph errors with response text", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ value: [{ id: "group-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      fetchGraphJson<{ value: Array<{ id: string }> }>({
        token: "graph-token",
        path: "/groups?$select=id",
        headers: { ConsistencyLevel: "eventual" },
      }),
    ).resolves.toEqual({ value: [{ id: "group-1" }] });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/groups?$select=id",
      {
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          ConsistencyLevel: "eventual",
        }),
      },
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    await expect(
      fetchGraphJson({
        token: "graph-token",
        path: "/teams/team-1/channels",
      }),
    ).rejects.toThrow("Graph /teams/team-1/channels failed (403): forbidden");
  });

  it("resolves Graph tokens through the SDK auth provider", async () => {
    const getAccessToken = vi.fn(async () => "raw-graph-token");
    const mockApp = { id: "mock-app" };

    resolveMSTeamsCredentialsMock.mockReturnValue({
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: mockApp });
    createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
    readAccessTokenMock.mockReturnValue("resolved-token");

    await expect(resolveGraphToken({ channels: { msteams: {} } })).resolves.toBe("resolved-token");

    expect(createMSTeamsTokenProviderMock).toHaveBeenCalledWith(mockApp);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expect(resolveGraphToken({ channels: {} })).rejects.toThrow(
      "MS Teams credentials missing",
    );

    const getAccessToken = vi.fn(async () => null);
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: { id: "mock-app" } });
    createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
    resolveMSTeamsCredentialsMock.mockReturnValue({
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    readAccessTokenMock.mockReturnValue(null);

    await expect(resolveGraphToken({ channels: { msteams: {} } })).rejects.toThrow(
      "MS Teams graph token unavailable",
    );
  });

  it("builds encoded Graph paths for teams and channels", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/groups?")) {
        return new Response(JSON.stringify({ value: [{ id: "team-1", displayName: "Ops" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ value: [{ id: "chan-1", displayName: "Deployments" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await expect(listTeamsByName("graph-token", "Bob's Team")).resolves.toEqual([
      { id: "team-1", displayName: "Ops" },
    ]);
    await expect(listChannelsForTeam("graph-token", "team/ops")).resolves.toEqual([
      { id: "chan-1", displayName: "Deployments" },
    ]);

    const calls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(calls[0]).toContain(
      "/groups?$filter=resourceProvisioningOptions%2FAny(x%3Ax%20eq%20'Team')%20and%20startsWith(displayName%2C'Bob''s%20Team')&$select=id,displayName",
    );
    expect(calls[1]).toContain("/teams/team%2Fops/channels?$select=id,displayName");
  });
});

describe("stripHtmlTags", () => {
  it("removes basic HTML tags", () => {
    expect(stripHtmlTags("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("preserves @mention display names from <at> tags", () => {
    expect(stripHtmlTags('<at id="123">John Doe</at> check this')).toBe("John Doe check this");
  });

  it("handles multiple @mentions", () => {
    expect(stripHtmlTags('<at id="1">Alice</at> and <at id="2">Bob</at> please review')).toBe(
      "Alice and Bob please review",
    );
  });

  it("decodes common HTML entities", () => {
    expect(stripHtmlTags("a &amp; b &lt; c &gt; d &quot;e&quot; f&apos;s")).toBe(
      'a & b < c > d "e" f\'s',
    );
  });

  it("decodes &#39; numeric entity for apostrophe", () => {
    expect(stripHtmlTags("it&#39;s fine")).toBe("it's fine");
  });

  it("replaces &nbsp; with space", () => {
    expect(stripHtmlTags("hello&nbsp;&nbsp;world")).toBe("hello world");
  });

  it("collapses whitespace and trims", () => {
    expect(stripHtmlTags("  hello   world  ")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripHtmlTags("")).toBe("");
  });

  it("handles plain text without HTML", () => {
    expect(stripHtmlTags("just plain text")).toBe("just plain text");
  });

  it("handles nested tags", () => {
    expect(stripHtmlTags("<div><span>nested</span></div>")).toBe("nested");
  });

  it("preserves word boundaries across block elements", () => {
    expect(stripHtmlTags("<div>First</div><div>Second</div>")).toBe("First Second");
    expect(stripHtmlTags("<p>Line one</p><p>Line two</p>")).toBe("Line one Line two");
  });

  it("handles br tags as separators", () => {
    expect(stripHtmlTags("hello<br>world")).toBe("hello world");
    expect(stripHtmlTags("hello<br/>world")).toBe("hello world");
  });

  it("handles typical Teams message with mention and formatting", () => {
    expect(
      stripHtmlTags(
        '<div><div><at id="0">OpenClaw Bot</at>&nbsp;what&#39;s the &quot;status&quot;?</div></div>',
      ),
    ).toBe('OpenClaw Bot what\'s the "status"?');
  });
});
