import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixRoomMessageEvent as roomMessage,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { matrixPreflightAudio } from "./preflight-audio.js";

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

function downloaded({ mxcUrl }: { mxcUrl: string }) {
  return {
    path: `/tmp/inbound/${mxcUrl.split("/").pop()}.jpg`,
    contentType: "image/jpeg",
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

  it("delivers every item of a captioned gallery in order with the caption as body", async () => {
    const f = setup();
    await f.send(gallery([item(1), item(2), item(3)], { body: "three sandwiches" }));

    expect(download.mock.calls.map(([params]) => params.mxcUrl)).toEqual([
      "mxc://example/img-1",
      "mxc://example/img-2",
      "mxc://example/img-3",
    ]);
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

    expect(download).toHaveBeenCalledTimes(3);
    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-3.jpg"],
      RawBody: "lunch\n\n[matrix gallery: 1 of 3 attachments unavailable]",
    });
  });

  it("says too large when the failed item exceeded the size limit", async () => {
    download.mockRejectedValueOnce(new MatrixMediaSizeLimitError());
    const f = setup();
    await f.send(gallery([item(1), item(2)]));

    // Each item carries its own declared size and type into the shared size limit.
    expect(download.mock.calls.map(([params]) => params)).toMatchObject([
      {
        sizeBytes: 1001,
        contentType: "image/jpeg",
        originalFilename: "photo-1.jpg",
        maxBytes: 5 * 1024 * 1024,
      },
      {
        sizeBytes: 1002,
        contentType: "image/jpeg",
        originalFilename: "photo-2.jpg",
        maxBytes: 5 * 1024 * 1024,
      },
    ]);
    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-2.jpg"],
      RawBody: "[matrix gallery: 1 of 2 attachments too large]",
    });
  });

  it("counts entries without a url as skipped", async () => {
    const f = setup();
    await f.send(gallery([item(1), { itemtype: "m.image", body: "no-url.jpg" }]));

    expect(download).toHaveBeenCalledTimes(1);
    expect(f.context().RawBody).toContain("[matrix gallery: 1 of 2 attachments unavailable]");
  });

  it("skips malformed and unknown itemtypes without losing valid siblings", async () => {
    const f = setup();
    // The stable m.gallery msgtype takes the same path as the unstable prefix.
    await f.send(
      gallery(
        [
          item(1),
          { itemtype: { toString: null }, url: "mxc://example/bad-1" },
          { itemtype: 7, url: "mxc://example/bad-2" },
          { itemtype: "m.sticker", url: "mxc://example/bad-3" },
          item(2),
        ],
        { msgtype: "m.gallery" },
      ),
    );

    expect(download.mock.calls.map(([params]) => params.mxcUrl)).toEqual([
      "mxc://example/img-1",
      "mxc://example/img-2",
    ]);
    expect(f.context()).toMatchObject({
      MediaPaths: ["/tmp/inbound/img-1.jpg", "/tmp/inbound/img-2.jpg"],
      RawBody: "[matrix gallery: 3 of 5 attachments unavailable]",
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
    expect(download.mock.calls.at(-1)![0].mxcUrl).toBe("mxc://example/img-20");
    expect(f.context().MediaPaths).toHaveLength(20);
    expect(f.context().RawBody).toBe("burst\n\n[matrix gallery: 2 of 22 attachments unavailable]");
  });

  it("does not run audio preflight on an audio item inside a gallery", async () => {
    const resolve = vi.spyOn(matrixPreflightAudio, "resolve").mockResolvedValue("transcript");
    const f = setup();
    await f.send(
      gallery([
        {
          itemtype: "m.audio",
          body: "memo.ogg",
          url: "mxc://example/memo",
          info: { mimetype: "audio/ogg" },
        },
      ]),
    );

    expect(download).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(f.context().MediaPaths).toEqual(["/tmp/inbound/memo.jpg"]);
    resolve.mockRestore();
  });

  it("records an unmentioned room gallery in pending history with its attachment count", async () => {
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

  it("forwards an encrypted item's file to the downloader", async () => {
    const f = setup();
    await f.send(
      gallery([
        item(1),
        {
          itemtype: "m.image",
          body: "enc.jpg",
          file: encryptedFile,
          info: { mimetype: "image/jpeg" },
        },
      ]),
    );

    expect(download).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mxcUrl: "mxc://example/enc-3", file: encryptedFile }),
    );
    expect(download.mock.calls[0]![0].file).toBeUndefined();
    expect(f.context().MediaPaths).toHaveLength(2);
  });

  it("saves decrypted bytes for an encrypted item and keeps its sibling when decryption fails", async () => {
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

    expect(download).toHaveBeenCalledOnce();
    expect(f.context()).toMatchObject({
      MediaPath: "/tmp/inbound/single.jpg",
      RawBody: "a sandwich",
      BodyForAgent: "a sandwich",
    });
  });
});
