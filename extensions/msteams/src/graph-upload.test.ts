// Msteams tests cover graph upload plugin behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import { resolveGraphChatId, uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

type FetchCall = [string, { method?: string; headers?: Record<string, string> } | undefined];

function requireFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): FetchCall {
  const call = fetchFn.mock.calls[index] as unknown as FetchCall | undefined;
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call;
}

function expectGraphUploadFetch(fetchFn: ReturnType<typeof vi.fn>, expectedUrl: string): void {
  const [url, init] = requireFetchCall(fetchFn);
  expect(url).toBe(expectedUrl);
  expect(init?.method).toBe("PUT");
  expect(init?.headers?.Authorization).toBe("Bearer graph-token");
  expect(init?.headers?.["Content-Type"]).toBe("application/octet-stream");
  expect(init?.headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
}

function bodyOnlyErrorResponse(body: string, status = 500): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: new Response(body).body,
  } as unknown as Response;
}

describe("graph upload helpers", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("uploads to OneDrive with the personal drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-1", webUrl: "https://example.com/1", name: "a.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/a.txt:/content",
    );
    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/1",
      name: "a.txt",
    });
  });

  it("uploads to SharePoint with the site drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("world"),
      filename: "b.txt",
      siteId: "site-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content",
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "item-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "bad.txt",
        siteId: "site-123",
        tokenProvider,
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });

  it("bounds upload error bodies without requiring response.text()", async () => {
    const fetchFn = vi.fn(async () =>
      bodyOnlyErrorResponse(`${"upload-denied ".repeat(4096)}tail-marker`, 413),
    );

    let error: unknown;
    try {
      await uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "large.txt",
        siteId: "site-123",
        tokenProvider,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("SharePoint upload failed (413): upload-denied");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });
});

describe("resolveGraphChatId", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("returns the ID directly when it already starts with 19:", async () => {
    const fetchFn = vi.fn();
    const result = await resolveGraphChatId({
      botFrameworkConversationId: "19:abc123@thread.tacv2",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });
    // Should short-circuit without making any API call
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toBe("19:abc123@thread.tacv2");
  });

  it("resolves personal DM chat ID via Graph API using user AAD object ID", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [{ id: "19:dm-chat-id@unq.gbl.spaces" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1abc_bot_framework_dm_id",
      userAadObjectId: "user-aad-object-id-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [callUrlRaw, init] = requireFetchCall(fetchFn);
    expect(init?.headers?.Authorization).toBe("Bearer graph-token");
    expect(init?.headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
    const callUrl = new URL(callUrlRaw);
    expect(callUrl.origin).toBe("https://graph.microsoft.com");
    expect(callUrl.pathname).toBe("/v1.0/me/chats");
    expect(callUrl.searchParams.get("$filter")).toBe(
      "chatType eq 'oneOnOne' and members/any(m:m/microsoft.graph.aadUserConversationMember/userId eq 'user-aad-object-id-123')",
    );
    expect(callUrl.searchParams.get("$select")).toBe("id");
    expect(result).toBe("19:dm-chat-id@unq.gbl.spaces");
  });

  it("resolves personal DM chat ID without user AAD object ID (lists all 1:1 chats)", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [{ id: "19:fallback-chat@unq.gbl.spaces" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "8:orgid:user-object-id",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toBe("19:fallback-chat@unq.gbl.spaces");
  });

  it("returns null when Graph API returns no chats", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1unknown_dm",
      userAadObjectId: "some-user",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(result).toBeNull();
  });

  it("returns null when Graph API call fails", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "content-type": "text/plain" },
        }),
    );

    const result = await resolveGraphChatId({
      botFrameworkConversationId: "a:1some_dm_id",
      userAadObjectId: "some-user",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loopback server helpers
// ---------------------------------------------------------------------------

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Loopback proof: readProviderJsonResponse replaces bare res.json() calls
// ---------------------------------------------------------------------------

describe("graph-upload readProviderJsonResponse loopback proof", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploadToOneDrive parses normal JSON response from a real loopback HTTP server", async () => {
    const payload = { id: "item-lp", webUrl: "https://example.com/lp", name: "lp.txt" };
    let receivedMethod: string | undefined;
    let receivedAuth: string | undefined;
    let contentLength: string | null | undefined;
    const server = createServer((req, res) => {
      receivedMethod = req.method;
      receivedAuth = req.headers.authorization;
      const body = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.write(body.slice(0, 10));
      res.end(body.slice(10));
    });
    const port = await listenLoopbackServer(server);

    try {
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
          const response = await realFetch(loopback, init);
          contentLength = response.headers.get("content-length");
          return response;
        }),
      );

      const result = await uploadToOneDrive({
        buffer: Buffer.from("hello"),
        filename: "lp.txt",
        tokenProvider,
      });

      expect(result).toEqual(payload);
      expect(receivedMethod).toBe("PUT");
      expect(receivedAuth).toBe("Bearer graph-token");
      expect(contentLength).toBeNull();
      console.log(
        `[msteams graph-upload loopback proof] uploadToOneDrive: returned=${JSON.stringify(result)} auth_ok=${receivedAuth === "Bearer graph-token"} content_length=${contentLength ?? "none"}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("uploadToSharePoint parses normal JSON response from a real loopback HTTP server", async () => {
    const payload = { id: "sp-lp", webUrl: "https://sp.example.com/lp", name: "sp-lp.txt" };
    let receivedMethod: string | undefined;
    let contentLength: string | null | undefined;
    const server = createServer((req, res) => {
      receivedMethod = req.method;
      const body = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.write(body.slice(0, 15));
      res.end(body.slice(15));
    });
    const port = await listenLoopbackServer(server);

    try {
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
          const response = await realFetch(loopback, init);
          contentLength = response.headers.get("content-length");
          return response;
        }),
      );

      const result = await uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "sp-lp.txt",
        siteId: "site-123",
        tokenProvider,
      });

      expect(result).toEqual(payload);
      expect(receivedMethod).toBe("PUT");
      expect(contentLength).toBeNull();
      console.log(
        `[msteams graph-upload loopback proof] uploadToSharePoint: returned=${JSON.stringify(result)} content_length=${contentLength ?? "none"}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("uploadToOneDrive surfaces a labelled error on malformed JSON from a real loopback HTTP server", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-valid-json");
    });
    const port = await listenLoopbackServer(server);

    try {
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
          return realFetch(loopback, init);
        }),
      );

      let error: unknown;
      try {
        await uploadToOneDrive({ buffer: Buffer.from("x"), filename: "bad.txt", tokenProvider });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("msteams.graph-upload.uploadOneDriveFile");
      expect(String(error)).toContain("malformed JSON response");
      console.log(
        `[msteams graph-upload loopback proof] malformed JSON labelled: ${String(error)}`,
      );
    } finally {
      await closeServer(server);
    }
  });
});

describe("buildTeamsFileInfoCard", () => {
  it("extracts a unique id from quoted etags and lowercases file extensions", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: '"{ABC-123},42"',
        name: "Quarterly.Report.PDF",
        webDavUrl: "https://sharepoint.example.com/file.pdf",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/file.pdf",
      name: "Quarterly.Report.PDF",
      content: {
        uniqueId: "ABC-123",
        fileType: "pdf",
      },
    });
  });

  it("keeps the raw etag when no version suffix exists and handles extensionless files", () => {
    expect(
      buildTeamsFileInfoCard({
        eTag: "plain-etag",
        name: "README",
        webDavUrl: "https://sharepoint.example.com/readme",
      }),
    ).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sharepoint.example.com/readme",
      name: "README",
      content: {
        uniqueId: "plain-etag",
        fileType: "",
      },
    });
  });
});
