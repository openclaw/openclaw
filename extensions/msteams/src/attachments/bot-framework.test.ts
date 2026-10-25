import { useAttachmentTestTransport } from "./transport.test-support.js";
const installAttachmentTestTransport = useAttachmentTestTransport();
import { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../../test-support/streaming-error-response.js";
import { getMSTeamsRuntime, setMSTeamsRuntime } from "../runtime.js";
import {
  downloadMSTeamsBotFrameworkAttachments as downloadAttachments,
  isBotFrameworkPersonalChatId,
} from "./bot-framework.js";
import type { MSTeamsAccessTokenProvider } from "./types.js";

beforeEach(() => {
  installAttachmentTestTransport({ resolveFn: async () => ({ address: "93.184.216.34" }) });
});

function downloadMSTeamsBotFrameworkAttachments({
  fetchFn,
  ...params
}: Parameters<typeof downloadAttachments>[0] & { fetchFn?: typeof fetch }) {
  if (fetchFn) {
    vi.stubGlobal("fetch", vi.fn(fetchFn));
  }
  return downloadAttachments(params);
}

type MockRuntime = {
  saveCalls: Buffer[];
  savePath: string;
  savedContentType: string;
};

type DownloadSingleAttachmentParams = Omit<
  Parameters<typeof downloadMSTeamsBotFrameworkAttachments>[0],
  "attachmentIds"
> & { attachmentId: string };

async function downloadMSTeamsBotFrameworkAttachment(
  params: Partial<DownloadSingleAttachmentParams>,
) {
  const { attachmentId = "att-1", ...rest } = params;
  const result = await downloadMSTeamsBotFrameworkAttachments({
    serviceUrl: "https://smba.trafficmanager.net/amer",
    tokenProvider: buildTokenProvider(),
    maxBytes: 10_000_000,
    ...rest,
    attachmentIds: [attachmentId],
  });
  return result.media[0];
}

function expectUnavailableMedia(media: unknown, sourceId: string): void {
  expect(media).toEqual({ kind: "document", sourceId });
}

function installRuntime(): MockRuntime {
  const state: MockRuntime = {
    saveCalls: [],
    savePath: "/tmp/bf-attachment.bin",
    savedContentType: "application/pdf",
  };
  setMSTeamsRuntime({
    channel: {
      media: {
        saveResponseMedia: async (response: Response) => {
          state.saveCalls.push(Buffer.from(await response.arrayBuffer()));
          return { path: state.savePath, contentType: state.savedContentType };
        },
      },
    },
  } as unknown as Parameters<typeof setMSTeamsRuntime>[0]);
  return state;
}

function attachmentInfo(views = [{ viewId: "original", size: 1 }]) {
  return Response.json({ name: "doc.pdf", type: "application/pdf", views });
}

function createMockFetch(info: Response, view?: Response | Error, id = "att-1"): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(`/v3/attachments/${id}/views/original`)) {
      if (view instanceof Error) {
        throw view;
      }
      return view ?? new Response("not found", { status: 404 });
    }
    // Fetch returns one body. Cloning tees it, so canceling the returned branch
    // would wait forever for the untouched fixture branch to be canceled too.
    return url.endsWith(`/v3/attachments/${id}`)
      ? info
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

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

describe("isBotFrameworkPersonalChatId", () => {
  it("returns false for null/undefined/empty", () => {
    expect(isBotFrameworkPersonalChatId(null)).toBe(false);
    expect(isBotFrameworkPersonalChatId(undefined)).toBe(false);
    expect(isBotFrameworkPersonalChatId("")).toBe(false);
  });
});

describe("downloadMSTeamsBotFrameworkAttachment", () => {
  let runtime: MockRuntime;
  beforeEach(() => {
    runtime = installRuntime();
  });

  it("fetches attachment info then view and saves media", async () => {
    const fileBytes = Buffer.from("PDFBYTES", "utf-8");
    const fetchFn = createMockFetch(
      attachmentInfo([{ viewId: "original", size: 1024 }]),
      new Response(fileBytes, { headers: { "content-length": String(fileBytes.byteLength) } }),
    );

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      fetchFn,
    });

    expect(media).toMatchObject({ path: runtime.savePath, contentType: runtime.savedContentType });
    expect(runtime.saveCalls).toEqual([Buffer.from("PDFBYTES", "utf-8")]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of vi.mocked(fetchFn).mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bf-token");
      expect(init).toHaveProperty("dispatcher");
    }
  });

  it("does not send Bot Framework service tokens to non-auth-allowlisted media hosts", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchFn: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    const media = await downloadMSTeamsBotFrameworkAttachment({
      serviceUrl: "https://attacker.trafficmanager.net",
      fetchFn,
    });

    expectUnavailableMedia(media, "att-1");
    expect(seenAuth).toEqual([null]);
    expect(runtime.saveCalls).toHaveLength(0);
  });

  it("skips when attachment view size exceeds maxBytes", async () => {
    const media = await downloadMSTeamsBotFrameworkAttachment({
      attachmentId: "big-1",
      fetchFn: createMockFetch(
        attachmentInfo([{ viewId: "original", size: 50_000_000 }]),
        undefined,
        "big-1",
      ),
    });

    expectUnavailableMedia(media, "big-1");
    expect(runtime.saveCalls).toHaveLength(0);
  });

  it("returns undefined when no views are returned", async () => {
    const media = await downloadMSTeamsBotFrameworkAttachment({
      attachmentId: "empty-1",
      fetchFn: createMockFetch(attachmentInfo([]), undefined, "empty-1"),
    });

    expectUnavailableMedia(media, "empty-1");
  });

  it("returns undefined without a tokenProvider", async () => {
    const fetchFn = vi.fn();
    const media = await downloadMSTeamsBotFrameworkAttachment({
      tokenProvider: undefined,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(media).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe("guarded attachment fetches", () => {
    it("logs a warning when the attachmentView fetch throws", async () => {
      const warn = vi.fn();
      const media = await downloadMSTeamsBotFrameworkAttachment({
        fetchFn: createMockFetch(attachmentInfo(), new TypeError("fetch failed")),
        logger: { warn },
      });

      expectUnavailableMedia(media, "att-1");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("msteams botFramework attachmentView fetch failed", {
        error: "fetch failed",
      });
    });

    it.each([
      {
        name: "attachment view is unavailable",
        init: { status: 500 },
        warning: "msteams botFramework attachmentView non-ok",
      },
      {
        name: "attachment view content-length is invalid",
        init: { status: 200, headers: { "content-length": "0x3" } },
        warning: "msteams botFramework attachmentView save failed",
      },
      {
        name: "attachment view exceeds maxBytes",
        init: { status: 200, headers: { "content-length": "11" } },
        warning: "msteams botFramework attachmentView save failed",
      },
    ] as const)("preserves the stable outcome when $name cleanup rejects", async (scenario) => {
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      const cancel = vi.fn(() => {
        throw new Error("discarded Teams response cancellation failed");
      });
      const body = new ReadableStream<Uint8Array>({ cancel });
      const discardedResponse = new Response(body, scenario.init);
      const warn = vi.fn();
      const fetchFn = createMockFetch(attachmentInfo(), discardedResponse);
      process.on("unhandledRejection", onUnhandledRejection);
      const save = vi
        .spyOn(getMSTeamsRuntime().channel.media, "saveResponseMedia")
        .mockImplementation(saveResponseMedia);

      try {
        const media = await downloadMSTeamsBotFrameworkAttachment({
          maxBytes: 10,
          fetchFn,
          logger: { warn },
        });

        expectUnavailableMedia(media, "att-1");
        expect(runtime.saveCalls).toHaveLength(0);
        expect(cancel).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(scenario.warning, expect.any(Object));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(unhandledRejections).toStrictEqual([]);
      } finally {
        save.mockRestore();
        process.off("unhandledRejection", onUnhandledRejection);
        expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
      }
    });

    it("bounds an unbounded attachmentInfo JSON body and cancels the stream", async () => {
      const chunkBytes = 1024 * 1024;
      const streamed = createStreamingResponse({
        status: 200,
        chunkCount: 64,
        chunkSize: chunkBytes,
        byte: 0x61,
        headers: { "content-type": "application/json" },
      });
      const jsonSpy = vi.spyOn(Response.prototype, "json").mockImplementation(async () => {
        throw new Error("raw response.json() should not be used");
      });
      const fetchFn: typeof fetch = vi.fn(async () => {
        return new Response(streamed.response.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const warn = vi.fn();
        const media = await downloadMSTeamsBotFrameworkAttachment({
          fetchFn,
          logger: { warn },
        });

        expectUnavailableMedia(media, "att-1");
        expect(jsonSpy).not.toHaveBeenCalled();
        // Enforced well before the 64 MiB test ceiling; an unbounded reader would keep pulling.
        expect(streamed.getReadCount()).toBeLessThan(32);
        expect(streamed.wasCanceled()).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          "msteams botFramework attachmentInfo parse failed",
          expect.objectContaining({
            error: expect.stringMatching(/JSON response exceeds 16777216 bytes/),
          }),
        );
      } finally {
        jsonSpy.mockRestore();
      }
    });
  });
});
