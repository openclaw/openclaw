import { describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  createMattermostPost,
  normalizeMattermostBaseUrl,
  updateMattermostPost,
} from "./client.js";

// ── Helper: mock fetch that captures requests ────────────────────────

function createMockFetch(response?: { status?: number; body?: unknown; contentType?: string }) {
  const status = response?.status ?? 200;
  const body = response?.body ?? {};
  const contentType = response?.contentType ?? "application/json";

  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    calls.push({ url: urlStr, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  });

  return { mockFetch: mockFetch as unknown as typeof fetch, calls };
}

// ── normalizeMattermostBaseUrl ────────────────────────────────────────

describe("normalizeMattermostBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeMattermostBaseUrl("http://localhost:8065/")).toBe("http://localhost:8065");
  });

  it("strips /api/v4 suffix", () => {
    expect(normalizeMattermostBaseUrl("http://localhost:8065/api/v4")).toBe(
      "http://localhost:8065",
    );
  });

  it("returns undefined for empty input", () => {
    expect(normalizeMattermostBaseUrl("")).toBeUndefined();
    expect(normalizeMattermostBaseUrl(null)).toBeUndefined();
    expect(normalizeMattermostBaseUrl(undefined)).toBeUndefined();
  });

  it("preserves valid base URL", () => {
    expect(normalizeMattermostBaseUrl("http://mm.example.com")).toBe("http://mm.example.com");
  });
});

// ── createMattermostClient ───────────────────────────────────────────

describe("createMattermostClient", () => {
  it("creates a client with normalized baseUrl", () => {
    const { mockFetch } = createMockFetch();
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065/",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    expect(client.baseUrl).toBe("http://localhost:8065");
    expect(client.apiBaseUrl).toBe("http://localhost:8065/api/v4");
  });

  it("throws on empty baseUrl", () => {
    expect(() => createMattermostClient({ baseUrl: "", botToken: "tok" })).toThrow(
      "baseUrl is required",
    );
  });

  it("sends Authorization header with Bearer token", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "u1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "my-secret-token",
      fetchImpl: mockFetch,
    });
    await client.request("/users/me");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer my-secret-token");
  });

  it("sets Content-Type for string bodies", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "p1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    await client.request("/posts", { method: "POST", body: JSON.stringify({ message: "hi" }) });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("throws on non-ok responses", async () => {
    const { mockFetch } = createMockFetch({
      status: 404,
      body: { message: "Not Found" },
    });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    await expect(client.request("/missing")).rejects.toThrow("Mattermost API 404");
  });

  it("returns undefined on 204 responses", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });
    const result = await client.request<unknown>("/anything", { method: "DELETE" });
    expect(result).toBeUndefined();
  });
});

// ── createMattermostPost ─────────────────────────────────────────────

describe("createMattermostPost", () => {
  it("sends channel_id and message", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Hello world",
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.channel_id).toBe("ch123");
    expect(body.message).toBe("Hello world");
  });

  it("includes rootId when provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post2" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Reply",
      rootId: "root456",
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.root_id).toBe("root456");
  });

  it("includes fileIds when provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post3" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "With file",
      fileIds: ["file1", "file2"],
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.file_ids).toEqual(["file1", "file2"]);
  });

  it("includes props when provided (for interactive buttons)", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post4" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    const props = {
      attachments: [
        {
          text: "Choose:",
          actions: [{ id: "btn1", type: "button", name: "Click" }],
        },
      ],
    };

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Pick an option",
      props,
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.props).toEqual(props);
    expect(body.props.attachments[0].actions[0].type).toBe("button");
  });

  it("omits props when not provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post5" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "No props",
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.props).toBeUndefined();
  });
});

// ── updateMattermostPost ─────────────────────────────────────────────

describe("updateMattermostPost", () => {
  it("sends PUT to /posts/{id}", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await updateMattermostPost(client, "post1", { message: "Updated" });

    expect(calls[0].url).toContain("/posts/post1");
    expect(calls[0].init?.method).toBe("PUT");
  });

  it("includes post id in the body", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await updateMattermostPost(client, "post1", { message: "Updated" });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.id).toBe("post1");
    expect(body.message).toBe("Updated");
  });

  it("includes props for button completion updates", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await updateMattermostPost(client, "post1", {
      message: "Original message",
      props: {
        attachments: [{ text: "✓ **do_now** selected by @tony" }],
      },
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.message).toBe("Original message");
    expect(body.props.attachments[0].text).toContain("✓");
    expect(body.props.attachments[0].text).toContain("do_now");
  });

  it("omits message when not provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await updateMattermostPost(client, "post1", {
      props: { attachments: [] },
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.id).toBe("post1");
    expect(body.message).toBeUndefined();
    expect(body.props).toEqual({ attachments: [] });
  });
});
