// Matrix tests cover outbound msgtype resolution formatting behavior.
import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { resolveMatrixMsgType } from "./formatting.js";
import { MsgType } from "./types.js";

// Wire the real core classifier so case sensitivity is exercised end-to-end
// (send.test.ts mocks mediaKindFromMime, so it cannot cover normalization).
function installRuntimeWithRealMediaKind(): void {
  setMatrixRuntime({
    media: { mediaKindFromMime },
  } as unknown as PluginRuntime);
}

describe("resolveMatrixMsgType", () => {
  afterEach(() => {
    setMatrixRuntime(undefined as unknown as PluginRuntime);
  });

  it("classifies mixed-case image content types as MsgType.Image", () => {
    installRuntimeWithRealMediaKind();
    expect(resolveMatrixMsgType("Image/PNG")).toBe(MsgType.Image);
  });

  it("classifies mixed-case audio content types as MsgType.Audio", () => {
    installRuntimeWithRealMediaKind();
    expect(resolveMatrixMsgType("Audio/Ogg")).toBe(MsgType.Audio);
  });

  it("classifies mixed-case video content types as MsgType.Video", () => {
    installRuntimeWithRealMediaKind();
    expect(resolveMatrixMsgType("Video/MP4")).toBe(MsgType.Video);
  });

  it("keeps lowercase image content types as MsgType.Image (regression)", () => {
    installRuntimeWithRealMediaKind();
    expect(resolveMatrixMsgType("image/png")).toBe(MsgType.Image);
  });
});
