import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { describe, expect, it } from "vitest";
import { readClawRouterCapabilityOffers } from "./capability-offers.js";
import {
  isPixVerseImageOffer,
  PIXVERSE_IMAGE_PATH,
  PIXVERSE_INPUT_PROFILE,
  preparePixVerseMultipart,
  readPixVerseId,
  readPixVerseStatus,
} from "./video-pixverse.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);
const request = (): VideoGenerationRequest => ({
  cfg: {},
  provider: "clawrouter",
  model: "pixverse/v6",
  prompt: "Synthetic moving square",
  inputImages: [{ buffer: Buffer.from(PNG), mimeType: "image/png" }],
});
function catalog() {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "pixverse",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/pixverse",
        routes: [
          {
            endpoint: "image_video",
            path: PIXVERSE_IMAGE_PATH,
            methods: ["POST"],
            requestFormat: "pixverse.image_video",
            responseFormat: "pixverse.video",
            inputProfile: PIXVERSE_INPUT_PROFILE,
          },
        ],
        models: [{ id: "pixverse/v6", upstream: "v6", capabilities: ["video.generate"] }],
        offers: [
          {
            endpoint: "image_video",
            modelId: "pixverse/v6",
            transport: "http",
            eligible: true,
            affordability: "request-dependent",
            routeKind: "native",
            route: "/v1/native/pixverse" + PIXVERSE_IMAGE_PATH,
            inputProfile: PIXVERSE_INPUT_PROFILE,
          },
        ],
      },
    ],
  };
}

describe("ClawRouter PixVerse composed image contract", () => {
  it.each(["pixverse/v6", "pixverse/c1"])(
    "encodes exactly one image and the bounded scalar plan for %s",
    async (model) => {
      const input = {
        ...request(),
        model,
        durationSeconds: 15,
        audio: true,
        providerOptions: {
          quality: "1080p",
          seed: 2147483647,
          negative_prompt: "",
          camera_movement: "zoom",
          template_id: 0,
          motion_mode: "normal",
        },
      };
      const prepared = preparePixVerseMultipart(input);
      input.inputImages![0]!.buffer!.fill(0);
      const form = await new Request("https://router.example/input", {
        method: "POST",
        headers: { "content-type": prepared.contentType },
        body: prepared.body,
      }).formData();
      const image = form.get("image") as File;
      expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
      expect(image.type).toBe("image/png");
      expect(form.get("model")).toBe(model.slice(9));
      expect(form.get("prompt")).toBe(input.prompt);
      expect(form.get("duration")).toBe("15");
      expect(form.get("generate_audio_switch")).toBe("true");
      expect(form.get("seed")).toBe("2147483647");
      expect(form.get("negative_prompt")).toBe("");
      expect(form.get("camera_movement")).toBe("zoom");
      expect(form.get("template_id")).toBe("0");
      expect(form.get("motion_mode")).toBe("normal");
      expect(form.get("quality")).toBe("1080p");
      expect(Array.from(form.keys())).toHaveLength(11);
      expect(prepared.body.length - PNG.length).toBeLessThanOrEqual(32 * 1024);
      expect(prepared.idempotencyKey).toMatch(/^[a-z0-9-]{36}$/u);
    },
  );
  it("accepts the exact image limit and rejects limit plus one before discovery", () => {
    const image = Buffer.alloc(8 * 1024 * 1024);
    PNG.copy(image);
    expect(
      preparePixVerseMultipart({
        ...request(),
        inputImages: [{ buffer: image, mimeType: "image/png" }],
      }).body.length,
    ).toBeLessThanOrEqual(image.length + 32 * 1024);
    expect(() =>
      preparePixVerseMultipart({
        ...request(),
        inputImages: [{ buffer: Buffer.concat([image, Buffer.alloc(1)]), mimeType: "image/png" }],
      }),
    ).toThrow(/at most 8 MiB/u);
  });
  it.each(["img_id", "image_url", "receipt", "grant", "idempotency_key", "authorization"])(
    "rejects caller authority %s",
    (name) => {
      expect(() =>
        preparePixVerseMultipart({ ...request(), providerOptions: { [name]: "synthetic" } }),
      ).toThrow(/not accepted/u);
    },
  );
  it.each([
    { inputImages: [] },
    { inputImages: [{ url: "https://image.example/image.png" }] },
    { inputImages: [{ buffer: PNG, mimeType: "image/jpeg" }] },
    { inputImages: [{ buffer: PNG, mimeType: "image/png", metadata: { img_id: 1 } }] },
    { inputVideos: [{ url: "https://video.example/input.mp4" }] },
    { inputAudios: [{ buffer: Buffer.from("audio") }] },
    { prompt: "字".repeat(683) },
    { durationSeconds: 0 },
    { durationSeconds: 16 },
    { durationSeconds: 1.5 },
    { providerOptions: { seed: -1 } },
    { providerOptions: { seed: 2147483648 } },
    { providerOptions: { template_id: 1.5 } },
    { providerOptions: { quality: "480p" } },
    { providerOptions: { motion_mode: "x".repeat(65) } },
    { providerOptions: { quality: "720p" }, resolution: "1080p" },
    { watermark: false },
  ] satisfies Partial<VideoGenerationRequest>[])("rejects unsupported intake %#", (override) => {
    expect(() => preparePixVerseMultipart({ ...request(), ...override })).toThrow();
  });
  it("requires the same exact input profile on both the native offer and endpoint", () => {
    const payload = catalog();
    const read = () =>
      readClawRouterCapabilityOffers(payload, "https://router.example/v1").filter((offer) =>
        isPixVerseImageOffer(offer, "pixverse/v6"),
      );
    expect(read()).toHaveLength(1);
    payload.providers[0]!.offers[0]!.inputProfile = "foreign";
    expect(read()).toEqual([]);
    payload.providers[0]!.routes[0]!.inputProfile = "foreign";
    expect(read()).toEqual([]);
    payload.providers[0]!.offers[0]!.inputProfile = payload.providers[0]!.routes[0]!.inputProfile =
      PIXVERSE_INPUT_PROFILE;
    payload.providers[0]!.offers[0]!.routeKind = "manifest";
    payload.providers[0]!.offers[0]!.route = "/v1/proxy/pixverse/image_video";
    expect(read()).toEqual([]);
  });
  it("keeps original identities, distinguishes deleted observation, and leaves output URLs opaque", () => {
    expect(readPixVerseId("9007199254740991")).toBe("9007199254740991");
    for (const value of [0, -1, 1.5, "01", "9007199254740992", {}, "https://other.example/"]) {
      expect(() => readPixVerseId(value)).toThrow();
    }
    const status = (Resp: object) => readPixVerseStatus({ ErrCode: 0, Resp }, "42");
    expect(status({ status: 5 })).toEqual({ complete: false, url: undefined });
    expect(
      status({ status: 1, video_id: 42, url: "https://media.example/result.mp4?opaque=synthetic" })
        .url,
    ).toBe("https://media.example/result.mp4?opaque=synthetic");
    expect(() =>
      status({ status: 1, video_id: 43, url: "https://media.example/foreign.mp4" }),
    ).toThrow(/different video identity/u);
    expect(() => status({ status: 6 })).toThrow(/observation is unavailable/u);
    for (const value of ["1", 0, 2, 7, 8]) {
      expect(() => status({ status: value })).toThrow();
    }
  });
});
