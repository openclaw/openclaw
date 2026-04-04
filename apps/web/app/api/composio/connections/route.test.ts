import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchComposioConnectionsMock,
  fetchComposioToolkitsMock,
  rebuildComposioToolIndexIfReadyMock,
} = vi.hoisted(() => ({
  fetchComposioConnectionsMock: vi.fn(),
  fetchComposioToolkitsMock: vi.fn(),
  rebuildComposioToolIndexIfReadyMock: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  fetchComposioConnections: fetchComposioConnectionsMock,
  fetchComposioToolkits: fetchComposioToolkitsMock,
  resolveComposioApiKey: vi.fn(() => "dench_test_key"),
  resolveComposioEligibility: vi.fn(() => ({
    eligible: true,
    lockReason: null,
    lockBadge: null,
  })),
  resolveComposioGatewayUrl: vi.fn(() => "https://gateway.example.com"),
}));

vi.mock("@/lib/composio-tool-index", () => ({
  rebuildComposioToolIndexIfReady: rebuildComposioToolIndexIfReadyMock,
}));

describe("Composio connections API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    rebuildComposioToolIndexIfReadyMock.mockResolvedValue({ ok: true });
    fetchComposioConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: "ca_twitter_1",
          toolkit_slug: "twitter",
          toolkit_name: "Twitter",
          status: "ACTIVE",
          created_at: "2026-04-03T00:00:00.000Z",
        },
      ],
    });
    fetchComposioToolkitsMock.mockResolvedValue({
      items: [
        {
          slug: "twitter",
          name: "Twitter",
          description: "Post and monitor updates",
          logo: "https://example.com/x.png",
          categories: ["Social"],
          auth_schemes: ["OAUTH2"],
          tools_count: 12,
        },
      ],
    });
  });

  it("resolves connected toolkit aliases and caches the fast path", async () => {
    const { GET } = await import("./route");
    const request = new Request("http://localhost/api/composio/connections?include_toolkits=1");

    const firstResponse = await GET(request);
    const firstBody = await firstResponse.json();
    const secondResponse = await GET(request);
    const secondBody = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstBody.toolkits[0]).toMatchObject({
      slug: "x",
      name: "X",
      connect_slug: "twitter",
      description: "Post and monitor updates",
      logo: "https://example.com/x.png",
      categories: ["Social"],
    });
    expect(secondBody.toolkits[0].slug).toBe("x");
    expect(fetchComposioConnectionsMock).toHaveBeenCalledTimes(1);
    expect(fetchComposioToolkitsMock).toHaveBeenCalledTimes(1);
    expect(fetchComposioToolkitsMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      { limit: 100 },
    );
    expect(rebuildComposioToolIndexIfReadyMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the connections cache when fresh=1 is requested", async () => {
    const { GET } = await import("./route");
    await GET(new Request("http://localhost/api/composio/connections?include_toolkits=1"));
    await GET(new Request("http://localhost/api/composio/connections?include_toolkits=1&fresh=1"));

    expect(fetchComposioConnectionsMock).toHaveBeenCalledTimes(2);
    expect(fetchComposioToolkitsMock).toHaveBeenCalledTimes(1);
  });

  it("uses connection-backed placeholders when the bulk toolkit fetch misses", async () => {
    fetchComposioToolkitsMock.mockResolvedValueOnce({ items: [] });
    fetchComposioConnectionsMock.mockResolvedValue({
      connections: [
        {
          id: "ca_gmail_1",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-03T00:00:00.000Z",
        },
      ],
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/composio/connections?include_toolkits=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.toolkits[0]).toMatchObject({
      slug: "gmail",
      name: "Gmail",
      description: "",
    });
    expect(fetchComposioToolkitsMock).toHaveBeenCalledTimes(1);
    expect(fetchComposioToolkitsMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      { limit: 100 },
    );
  });
});
