// Msteams tests cover attachment download auth-fallback cancel behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResponseWithRejectingCancel, watchUnhandledRejections } from "./test-helpers.js";
import type { MSTeamsAccessTokenProvider } from "./types.js";

const saveResponseMediaMock = vi.hoisted(() =>
  vi.fn(
    async (
      response: Response,
      options?: { maxBytes?: number },
    ): Promise<{
      id: string;
      path: string;
      size: number;
      contentType?: string;
      fileName?: string;
    }> => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && options?.maxBytes && contentLength > options.maxBytes) {
        throw new Error(`content length ${contentLength} exceeds maxBytes ${options.maxBytes}`);
      }
      return {
        id: "saved",
        path: "/tmp/saved.png",
        size: 42,
        contentType: response.headers.get("content-type") ?? "image/png",
      };
    },
  ),
);

vi.mock("openclaw/plugin-sdk/media-runtime", async () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    media: {
      detectMime: vi.fn(async () => "image/png"),
    },
    channel: {
      media: {
        saveMediaBuffer: vi.fn(async (buffer: Buffer, contentType?: string) => ({
          id: "saved",
          path: "/tmp/saved.png",
          size: buffer.length,
          contentType: contentType ?? "image/png",
        })),
        saveRemoteMedia: vi.fn(),
      },
    },
  }),
}));

import { downloadMSTeamsAttachments } from "./download.js";

function buildTokenProvider(): MSTeamsAccessTokenProvider {
  return {
    getAccessToken: vi.fn(async (scope: string) => {
      if (scope.includes("botframework.com")) {
        return "bf-token";
      }
      return "graph-token";
    }),
  };
}

async function resolvePublicHost(): Promise<{ address: string }> {
  return { address: "93.184.216.34" };
}

function makeAttachment(): {
  contentType: string;
  contentUrl: string;
  name: string;
} {
  return {
    contentType: "application/pdf",
    contentUrl: "https://graph.microsoft.com/v1.0/foo",
    name: "doc.pdf",
  };
}

describe("downloadMSTeamsAttachments rejecting body.cancel() regression coverage", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockClear();
  });

  it("cancels the firstAttempt 401 body before auth fallback", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (!auth) {
          return createResponseWithRejectingCancel("unauthorized", { status: 401 });
        }
        return new Response(Buffer.from("OK"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      });

      const result = await downloadMSTeamsAttachments({
        attachments: [makeAttachment()],
        maxBytes: 10_000_000,
        tokenProvider: buildTokenProvider(),
        fetchFn: fetchFn as unknown as typeof fetch,
        fetchFnSupportsDispatcher: true,
        resolveFn: resolvePublicHost,
      });

      expect(result).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      watcher.detach();
    }
    expect(watcher.unhandled).toEqual([]);
  });

  it("cancels a non-auth-failure authAttempt body and continues to the next scope", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (!auth) {
          return createResponseWithRejectingCancel("unauthorized", { status: 401 });
        }
        if (auth.includes("graph-token")) {
          return createResponseWithRejectingCancel("server error", { status: 500 });
        }
        return new Response(Buffer.from("OK"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      });

      const result = await downloadMSTeamsAttachments({
        attachments: [makeAttachment()],
        maxBytes: 10_000_000,
        tokenProvider: buildTokenProvider(),
        fetchFn: fetchFn as unknown as typeof fetch,
        fetchFnSupportsDispatcher: true,
        resolveFn: resolvePublicHost,
      });

      expect(result).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      watcher.detach();
    }
    expect(watcher.unhandled).toEqual([]);
  });

  it("cancels a 401 authAttempt body before trying the next scope", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (!auth) {
          return createResponseWithRejectingCancel("unauthorized", { status: 401 });
        }
        if (auth.includes("graph-token")) {
          return createResponseWithRejectingCancel("forbidden", { status: 403 });
        }
        return new Response(Buffer.from("OK"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      });

      const result = await downloadMSTeamsAttachments({
        attachments: [makeAttachment()],
        maxBytes: 10_000_000,
        tokenProvider: buildTokenProvider(),
        fetchFn: fetchFn as unknown as typeof fetch,
        fetchFnSupportsDispatcher: true,
        resolveFn: resolvePublicHost,
      });

      expect(result).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      watcher.detach();
    }
    expect(watcher.unhandled).toEqual([]);
  });
});
