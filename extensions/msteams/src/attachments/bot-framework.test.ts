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

beforeEach(() => {
  installAttachmentTestTransport({ resolveFn: async () => ({ address: "93.184.216.34" }) });
});

async function downloadAttachment(
  fetchFn: typeof fetch,
  params: Partial<Omit<Parameters<typeof downloadAttachments>[0], "attachmentIds">> = {},
) {
  vi.stubGlobal("fetch", fetchFn);
  const result = await downloadAttachments({
    serviceUrl: "https://smba.trafficmanager.net/amer",
    tokenProvider: {
      getAccessToken: vi.fn(async (scope: string) =>
        scope.includes("botframework.com") ? "bf-token" : "graph-token",
      ),
    },
    maxBytes: 10_000_000,
    ...params,
    attachmentIds: ["att-1"],
  });
  return result.media[0];
}

function expectUnavailableMedia(media: unknown): void {
  expect(media).toEqual({ kind: "document", sourceId: "att-1" });
}

const savedMedia = { path: "/tmp/bf-attachment.bin", contentType: "application/pdf" };

function installRuntime() {
  const saveCalls: Buffer[] = [];
  setMSTeamsRuntime({
    channel: {
      media: {
        saveResponseMedia: async (response: Response) => {
          saveCalls.push(Buffer.from(await response.arrayBuffer()));
          return savedMedia;
        },
      },
    },
  } as unknown as Parameters<typeof setMSTeamsRuntime>[0]);
  return saveCalls;
}

function attachmentInfo(views = [{ viewId: "original", size: 1 }]) {
  return Response.json({ name: "doc.pdf", type: "application/pdf", views });
}

function createMockFetch(info: Response, view?: Response | Error): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v3/attachments/att-1/views/original")) {
      if (view instanceof Error) {
        throw view;
      }
      return view ?? new Response("not found", { status: 404 });
    }
    // Fetch returns one body. Cloning tees it, so canceling the returned branch
    // would wait forever for the untouched fixture branch to be canceled too.
    return url.endsWith("/v3/attachments/att-1")
      ? info
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

it("isBotFrameworkPersonalChatId returns false for null/undefined/empty", () => {
  expect(isBotFrameworkPersonalChatId(null)).toBe(false);
  expect(isBotFrameworkPersonalChatId(undefined)).toBe(false);
  expect(isBotFrameworkPersonalChatId("")).toBe(false);
});

describe("downloadMSTeamsBotFrameworkAttachment", () => {
  let runtime: ReturnType<typeof installRuntime>;
  beforeEach(() => {
    runtime = installRuntime();
  });

  it("fetches attachment info then view and saves media", async () => {
    const fileBytes = Buffer.from("PDFBYTES", "utf-8");
    const fetchFn = createMockFetch(
      attachmentInfo([{ viewId: "original", size: 1024 }]),
      new Response(fileBytes, { headers: { "content-length": String(fileBytes.byteLength) } }),
    );

    const media = await downloadAttachment(fetchFn, {
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    });

    expect(media).toMatchObject(savedMedia);
    expect(runtime).toEqual([fileBytes]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of vi.mocked(fetchFn).mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bf-token");
      expect(init).toHaveProperty("dispatcher");
    }
  });

  it("does not send Bot Framework service tokens to non-auth-allowlisted media hosts", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("unauthorized", { status: 401 }));
    const media = await downloadAttachment(fetchFn, {
      serviceUrl: "https://attacker.trafficmanager.net",
    });

    expectUnavailableMedia(media);
    expect(
      fetchFn.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual([null]);
    expect(runtime).toHaveLength(0);
  });

  it.each([
    ["oversized", [{ viewId: "original", size: 50_000_000 }]],
    ["missing", []],
  ] as const)("skips %s attachment views", async (_name, views) => {
    const media = await downloadAttachment(createMockFetch(attachmentInfo([...views])));
    expectUnavailableMedia(media);
    expect(runtime).toHaveLength(0);
  });

  it("returns undefined without a tokenProvider", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const media = await downloadAttachment(fetchFn, { tokenProvider: undefined });
    expect(media).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe("guarded attachment fetches", () => {
    it("logs a warning when the attachmentView fetch throws", async () => {
      const warn = vi.fn();
      const media = await downloadAttachment(
        createMockFetch(attachmentInfo(), new TypeError("fetch failed")),
        { logger: { warn } },
      );

      expectUnavailableMedia(media);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("msteams botFramework attachmentView fetch failed", {
        error: "fetch failed",
      });
    });

    it.each([
      ["unavailable", { status: 500 }, "non-ok"],
      ["invalid length", { headers: { "content-length": "0x3" } }, "save failed"],
      ["oversized", { headers: { "content-length": "11" } }, "save failed"],
    ] satisfies [string, ResponseInit, string][])(
      "preserves %s outcome when cleanup rejects",
      async (_name, init, warning) => {
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
          unhandledRejections.push(reason);
        };
        const cancel = vi.fn(() => {
          throw new Error("discarded Teams response cancellation failed");
        });
        const discardedResponse = new Response(new ReadableStream<Uint8Array>({ cancel }), init);
        const warn = vi.fn();
        const fetchFn = createMockFetch(attachmentInfo(), discardedResponse);
        process.on("unhandledRejection", onUnhandledRejection);
        const save = vi
          .spyOn(getMSTeamsRuntime().channel.media, "saveResponseMedia")
          .mockImplementation(saveResponseMedia);

        try {
          const media = await downloadAttachment(fetchFn, {
            maxBytes: 10,
            logger: { warn },
          });

          expectUnavailableMedia(media);
          expect(runtime).toHaveLength(0);
          expect(cancel).toHaveBeenCalledOnce();
          expect(warn).toHaveBeenCalledWith(
            `msteams botFramework attachmentView ${warning}`,
            expect.any(Object),
          );
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(unhandledRejections).toStrictEqual([]);
        } finally {
          save.mockRestore();
          process.off("unhandledRejection", onUnhandledRejection);
          expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
        }
      },
    );

    it("bounds an unbounded attachmentInfo JSON body and cancels the stream", async () => {
      const streamed = createStreamingResponse({
        status: 200,
        chunkCount: 64,
        chunkSize: 1024 * 1024,
        byte: 0x61,
        headers: { "content-type": "application/json" },
      });
      const warn = vi.fn();
      const media = await downloadAttachment(
        vi.fn(async () => streamed.response),
        {
          logger: { warn },
        },
      );

      expectUnavailableMedia(media);
      // Enforced well before the 64 MiB test ceiling; an unbounded reader would keep pulling.
      expect(streamed.getReadCount()).toBeLessThan(32);
      expect(streamed.wasCanceled()).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "msteams botFramework attachmentInfo parse failed",
        expect.objectContaining({
          error: expect.stringMatching(/JSON response exceeds 16777216 bytes/),
        }),
      );
    });
  });
});
