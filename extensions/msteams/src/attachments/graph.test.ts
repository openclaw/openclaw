import { describe, expect, it, vi } from "vitest";

// Mock shared.js to avoid transitive runtime-api imports that pull in uninstalled packages.
vi.mock("./shared.js", () => ({
  applyAuthorizationHeaderForUrl: vi.fn(),
  GRAPH_ROOT: "https://graph.microsoft.com/v1.0",
  inferPlaceholder: vi.fn(({ contentType }: { contentType?: string }) =>
    contentType?.startsWith("image/") ? "[image]" : "[file]",
  ),
  isRecord: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
  isUrlAllowed: vi.fn(() => true),
  normalizeContentType: vi.fn((ct: string | null | undefined) => ct ?? undefined),
  resolveMediaSsrfPolicy: vi.fn(() => undefined),
  resolveAttachmentFetchPolicy: vi.fn(() => ({ allowHosts: ["*"], authAllowHosts: ["*"] })),
  resolveRequestUrl: vi.fn((input: string) => input),
  safeFetchWithPolicy: vi.fn(),
}));

vi.mock("../../runtime-api.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => ({
    media: {
      detectMime: vi.fn(async () => "image/png"),
    },
    channel: {
      media: {
        saveMediaBuffer: vi.fn(async (_buf: Buffer, ct: string) => ({
          path: "/tmp/saved.png",
          contentType: ct ?? "image/png",
        })),
      },
    },
  })),
}));

vi.mock("./download.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
}));

vi.mock("./remote-media.js", () => ({
  downloadAndStoreMSTeamsRemoteMedia: vi.fn(),
}));

import { fetchWithSsrFGuard } from "../../runtime-api.js";
import { downloadMSTeamsGraphMedia } from "./graph.js";

function mockFetchResponse(body: unknown, status = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, { status, headers: { "content-type": "application/json" } });
}

function mockBinaryResponse(data: Uint8Array, status = 200) {
  return new Response(Buffer.from(data) as BodyInit, { status });
}

describe("downloadMSTeamsGraphMedia hosted content $value fallback", () => {
  it("fetches $value endpoint when contentBytes is null but item.id exists", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    const fetchCalls: string[] = [];

    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: { url: string }) => {
      fetchCalls.push(params.url);
      const url = params.url;

      // Main message fetch
      if (url.endsWith("/messages/msg-1") && !url.includes("hostedContents")) {
        return {
          response: mockFetchResponse({ body: {}, attachments: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      // hostedContents collection
      if (url.endsWith("/hostedContents")) {
        return {
          response: mockFetchResponse({
            value: [{ id: "hosted-123", contentType: "image/png", contentBytes: null }],
          }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      // $value endpoint (the fallback being tested)
      if (url.includes("/hostedContents/hosted-123/$value")) {
        return {
          response: mockBinaryResponse(imageBytes),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      // attachments collection
      if (url.endsWith("/attachments")) {
        return {
          response: mockFetchResponse({ value: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      return {
        response: mockFetchResponse({}, 404),
        release: async () => {},
        finalUrl: params.url,
      };
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-1",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // Verify the $value endpoint was fetched
    const valueCall = fetchCalls.find((u) => u.includes("/hostedContents/hosted-123/$value"));
    expect(valueCall).toBeDefined();
    expect(result.media.length).toBeGreaterThan(0);
    expect(result.hostedCount).toBe(1);
  });

  it("skips hosted content when contentBytes is null and id is missing", async () => {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: { url: string }) => {
      const url = params.url;
      if (url.endsWith("/messages/msg-2") && !url.includes("hostedContents")) {
        return {
          response: mockFetchResponse({ body: {}, attachments: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/hostedContents")) {
        return {
          response: mockFetchResponse({
            value: [{ contentType: "image/png", contentBytes: null }],
          }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/attachments")) {
        return {
          response: mockFetchResponse({ value: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      return {
        response: mockFetchResponse({}, 404),
        release: async () => {},
        finalUrl: params.url,
      };
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-2",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // No media because there's no id to fetch $value from and no contentBytes
    expect(result.media).toHaveLength(0);
  });

  it("skips $value content when Content-Length exceeds maxBytes", async () => {
    const fetchCalls: string[] = [];

    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: { url: string }) => {
      fetchCalls.push(params.url);
      const url = params.url;
      if (url.endsWith("/messages/msg-cl") && !url.includes("hostedContents")) {
        return {
          response: mockFetchResponse({ body: {}, attachments: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/hostedContents")) {
        return {
          response: mockFetchResponse({
            value: [{ id: "hosted-big", contentType: "image/png", contentBytes: null }],
          }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.includes("/hostedContents/hosted-big/$value")) {
        // Return a response whose Content-Length exceeds maxBytes
        const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        return {
          response: new Response(Buffer.from(data) as BodyInit, {
            status: 200,
            headers: { "content-length": "999999999" },
          }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/attachments")) {
        return {
          response: mockFetchResponse({ value: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      return {
        response: mockFetchResponse({}, 404),
        release: async () => {},
        finalUrl: params.url,
      };
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-cl",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 1024, // 1 KB limit
    });

    // $value was fetched but skipped due to Content-Length exceeding maxBytes
    const valueCall = fetchCalls.find((u) => u.includes("/hostedContents/hosted-big/$value"));
    expect(valueCall).toBeDefined();
    expect(result.media).toHaveLength(0);
  });

  it("uses inline contentBytes when available instead of $value", async () => {
    const fetchCalls: string[] = [];
    const base64Png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: { url: string }) => {
      fetchCalls.push(params.url);
      const url = params.url;
      if (url.endsWith("/messages/msg-3") && !url.includes("hostedContents")) {
        return {
          response: mockFetchResponse({ body: {}, attachments: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/hostedContents")) {
        return {
          response: mockFetchResponse({
            value: [{ id: "hosted-456", contentType: "image/png", contentBytes: base64Png }],
          }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      if (url.endsWith("/attachments")) {
        return {
          response: mockFetchResponse({ value: [] }),
          release: async () => {},
          finalUrl: params.url,
        };
      }
      return {
        response: mockFetchResponse({}, 404),
        release: async () => {},
        finalUrl: params.url,
      };
    });

    const result = await downloadMSTeamsGraphMedia({
      messageUrl: "https://graph.microsoft.com/v1.0/chats/c/messages/msg-3",
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
      maxBytes: 10 * 1024 * 1024,
    });

    // Should NOT have fetched $value since contentBytes was available
    const valueCall = fetchCalls.find((u) => u.includes("/$value"));
    expect(valueCall).toBeUndefined();
    expect(result.media.length).toBeGreaterThan(0);
  });
});
