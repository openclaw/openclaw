import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixRoomMessageEvent as roomMessage,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const { download } = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return { ...actual, downloadMatrixMedia: download };
});

type MessageContent = Parameters<typeof roomMessage>[0]["content"];

const GALLERY = "dm.filament.gallery";
const encryptedFile = {
  url: "mxc://example/enc-3",
  key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
  iv: "iv",
  hashes: { sha256: "hash" },
  v: "v2",
};

function item(n: number, extra: Record<string, unknown> = {}) {
  return {
    itemtype: "m.image",
    body: `photo-${n}.jpg`,
    filename: `photo-${n}.jpg`,
    url: `mxc://example/img-${n}`,
    info: { mimetype: "image/jpeg", size: 1000 + n },
    ...extra,
  };
}

function gallery(itemtypes: unknown[], extra: MessageContent = {}): MessageContent {
  return { msgtype: GALLERY, body: "", itemtypes, ...extra };
}

function downloaded({
  mxcUrl,
  contentType = "image/jpeg",
}: {
  mxcUrl: string;
  contentType?: string;
}) {
  const ext = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  return {
    path: `/tmp/inbound/${mxcUrl.split("/").pop()}.${ext}`,
    contentType,
    placeholder: "[matrix media]",
  };
}

function setup(options: NonNullable<Parameters<typeof createHarness>[0]> = {}) {
  const harness = createHarness({
    isDirectMessage: true,
    mediaMaxBytes: 5 * 1024 * 1024,
    ...options,
  });
  return {
    ...harness,
    send: (content: MessageContent) =>
      harness.handler(
        "!room:example.org",
        roomMessage({ eventId: "$gallery", sender: "@frank:matrix.example.org", content }),
      ),
    context: () => harness.runPrepared.mock.calls.at(-1)![0].ctxPayload,
  };
}

describe("createMatrixRoomMessageHandler gallery messages", () => {
  beforeEach(() => {
    download.mockReset().mockImplementation(async (params) => downloaded(params));
    installMatrixMonitorTestRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers every item of a captioned gallery in order with the caption as body", async () => {
    const f = setup();
    await f.send(gallery([item(1), item(2), item(3)], { body: "three sandwiches" }));

    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-2.jpg", "/tmp/inbound/img-3.jpg"],
      RawBody: "three sandwiches",
      BodyForAgent: "three sandwiches",
    });
  });

  it("does not drop a gallery without a caption", async () => {
    const f = setup();
    await f.send(gallery([item(1), item(2)]));

    expect(f.runPrepared).toHaveBeenCalledOnce();
    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-2.jpg"],
      BodyForAgent: "[matrix gallery: 2 attachments]",
    });
  });

  it("keeps the other items and marks one unavailable when a download fails", async () => {
    download.mockImplementation(async (params) => {
      if (params.mxcUrl === "mxc://example/img-2") {
        throw new Error("download failed");
      }
      return downloaded(params);
    });
    const f = setup();
    await f.send(gallery([item(1), item(2), item(3)], { body: "lunch" }));

    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-3.jpg"],
      RawBody: "lunch\n\n[matrix gallery: 1 of 3 attachments unavailable]",
    });
  });

  it("says too large when an item exceeds mediaMaxBytes", async () => {
    const { downloadMatrixMedia } =
      await vi.importActual<typeof import("./media.js")>("./media.js");
    download.mockImplementation(downloadMatrixMedia);
    installMatrixMonitorTestRuntime({
      saveMediaBuffer: (async (buffer: Buffer) => ({
        path: `/tmp/inbound/${buffer.toString()}.jpg`,
        contentType: "image/jpeg",
      })) as never,
    });
    const downloadContent = vi.fn().mockResolvedValue(Buffer.from("small"));
    const f = setup({ client: { downloadContent } as never });
    await f.send(
      gallery([item(1, { info: { mimetype: "image/jpeg", size: 6 * 1024 * 1024 } }), item(2)]),
    );

    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/small.jpg"],
      RawBody: "[matrix gallery: 1 of 2 attachments too large]",
    });
  });

  it("skips malformed, unknown and url-less entries without losing valid siblings", async () => {
    const f = setup();
    // The stable m.gallery msgtype takes the same path as the unstable prefix.
    await f.send(
      gallery(
        [
          item(1),
          { itemtype: { toString: null }, url: "mxc://example/bad-1" },
          { itemtype: 7, url: "mxc://example/bad-2" },
          { itemtype: "m.sticker", url: "mxc://example/bad-3" },
          { itemtype: "m.image", body: "no-url.jpg" },
          item(2),
        ],
        { msgtype: "m.gallery" },
      ),
    );

    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-2.jpg"],
      RawBody: "[matrix gallery: 4 of 6 attachments unavailable]",
    });
  });

  it("downloads at most 20 items and reports the rest as unavailable", async () => {
    const f = setup();
    await f.send(
      gallery(
        Array.from({ length: 22 }, (_, i) => item(i + 1)),
        { body: "burst" },
      ),
    );

    expect(download).toHaveBeenCalledTimes(20);
    expect(f.context().MediaPaths).toHaveLength(20);
    expect(f.context().RawBody).toBe("burst\n\n[matrix gallery: 2 of 22 attachments unavailable]");
  });

  it("records an unmentioned room gallery as text in history", async () => {
    const f = setup({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      dispatchInboundMessage: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });
    await f.send(gallery([item(1), item(2), item(3)], { body: "lunch" }));
    expect(download).not.toHaveBeenCalled();
    await f.handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$trigger",
        body: "@room what is this?",
        mentions: { room: true },
      }),
    );

    expect(f.context().InboundHistory?.map((entry) => entry.body)).toEqual([
      "lunch\n\n[matrix gallery: 3 attachments]",
    ]);
  });

  it("uses the marker as the body when every item fails", async () => {
    download.mockRejectedValue(new Error("download failed"));
    const f = setup();
    await f.send(gallery([item(1), item(2)]));

    expect(f.context()).toMatchObject({
      RawBody: "[matrix gallery: 2 of 2 attachments unavailable]",
    });
    expect(f.context().MediaPaths).toBeUndefined();
  });

  it("decrypts encrypted items and keeps siblings when one fails", async () => {
    const { downloadMatrixMedia } =
      await vi.importActual<typeof import("./media.js")>("./media.js");
    download.mockImplementation(downloadMatrixMedia);
    const saveMediaBuffer = vi.fn(async (buffer: Buffer) => ({
      path: `/tmp/inbound/${buffer.toString()}.jpg`,
      contentType: "image/jpeg",
    }));
    installMatrixMonitorTestRuntime({ saveMediaBuffer: saveMediaBuffer as never });
    const decryptMedia = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("decrypted"))
      .mockRejectedValueOnce(new Error("bad key"));
    const downloadContent = vi.fn().mockResolvedValue(Buffer.from("plain"));
    const f = setup({ client: { crypto: { decryptMedia }, downloadContent } as never });
    const encrypted = (n: number) => ({
      itemtype: "m.image",
      body: `enc-${n}.jpg`,
      file: { ...encryptedFile, url: `mxc://example/enc-${n}` },
      info: { mimetype: "image/jpeg" },
    });
    await f.send(gallery([encrypted(1), item(2), encrypted(3)]));

    expect(saveMediaBuffer.mock.calls.map(([buffer]) => buffer.toString())).toEqual([
      "decrypted",
      "plain",
    ]);
    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/decrypted.jpg", "/tmp/inbound/plain.jpg"],
      RawBody: "[matrix gallery: 1 of 3 attachments unavailable]",
    });
  });

  it("keeps single image messages unchanged", async () => {
    const f = setup();
    await f.send({
      msgtype: "m.image",
      body: "a sandwich",
      filename: "sandwich.jpg",
      url: "mxc://example/single",
      info: { mimetype: "image/jpeg" },
    });

    expect(f.context()).toMatchObject({
      MediaPath: "/tmp/inbound/single.jpg",
      RawBody: "a sandwich",
      BodyForAgent: "a sandwich",
    });
  });
});
