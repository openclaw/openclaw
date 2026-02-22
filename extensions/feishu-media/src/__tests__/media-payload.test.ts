import { describe, it, expect } from "vitest";
import { buildFeishuMediaPayload, type FeishuMediaInfoExt } from "../media-payload.js";

describe("buildFeishuMediaPayload", () => {
  it("returns basic media fields for a single media item", () => {
    const media: FeishuMediaInfoExt[] = [
      { path: "/tmp/image.jpg", contentType: "image/jpeg", placeholder: "<media:image>" },
    ];
    const payload = buildFeishuMediaPayload(media);
    expect(payload.MediaPath).toBe("/tmp/image.jpg");
    expect(payload.MediaType).toBe("image/jpeg");
    expect(payload.MediaUrl).toBe("/tmp/image.jpg");
    expect(payload.Transcript).toBeUndefined();
  });

  it("includes Transcript when audio has transcript", () => {
    const media: FeishuMediaInfoExt[] = [
      {
        path: "/tmp/voice.ogg",
        contentType: "audio/ogg",
        placeholder: "<media:audio>",
        transcript: "Hello world",
      },
    ];
    const payload = buildFeishuMediaPayload(media);
    expect(payload.Transcript).toBe("Hello world");
    expect(payload.MediaTypes).toEqual(["audio/ogg"]);
  });

  it("handles multiple media items", () => {
    const media: FeishuMediaInfoExt[] = [
      { path: "/tmp/a.jpg", contentType: "image/jpeg", placeholder: "<media:image>" },
      { path: "/tmp/b.png", contentType: "image/png", placeholder: "<media:image>" },
    ];
    const payload = buildFeishuMediaPayload(media);
    expect(payload.MediaPaths).toEqual(["/tmp/a.jpg", "/tmp/b.png"]);
    expect(payload.MediaUrls).toEqual(["/tmp/a.jpg", "/tmp/b.png"]);
    expect(payload.MediaTypes).toEqual(["image/jpeg", "image/png"]);
  });

  it("returns empty arrays as undefined", () => {
    const payload = buildFeishuMediaPayload([]);
    expect(payload.MediaPaths).toBeUndefined();
    expect(payload.MediaUrls).toBeUndefined();
    expect(payload.MediaTypes).toBeUndefined();
    expect(payload.MediaPath).toBeUndefined();
  });

  it("finds transcript from first media with transcript in multi-item list", () => {
    const media: FeishuMediaInfoExt[] = [
      { path: "/tmp/img.jpg", contentType: "image/jpeg", placeholder: "<media:image>" },
      { path: "/tmp/voice.ogg", contentType: "audio/ogg", placeholder: "<media:audio>", transcript: "Hi there" },
    ];
    const payload = buildFeishuMediaPayload(media);
    expect(payload.Transcript).toBe("Hi there");
    // MediaPath is from first item
    expect(payload.MediaPath).toBe("/tmp/img.jpg");
  });
});
