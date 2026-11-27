import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

const capture = vi.hoisted(() => ({
  start: vi.fn(),
  read: vi.fn<() => { frame: { jpeg: Buffer; capturedAtMs: number } } | { unavailable: string }>(),
  stop: vi.fn(async () => {}),
}));
vi.mock("../src/video-capture.js", () => ({
  startFaceTimeVideoCapture: capture.start,
}));

const frame = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
const look = { itemId: "item-look", callId: "call-look", name: "facetime_look", args: {} };

describe("FaceTime talk driver vision", () => {
  beforeEach(() => {
    resetTalkDriverMocks();
    capture.start.mockReturnValue({ read: capture.read, stop: capture.stop });
    capture.read.mockReturnValue({ frame: { jpeg: frame, capturedAtMs: Date.now() - 400 } });
    mocks.bridge.sendImage.mockReturnValue(true);
    mocks.resolveProvider.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: {},
      capabilities: { supportsVideoFrames: true },
    } as never);
  });

  it("offers the look tool and shows the model a frame before answering its tool call", async () => {
    const driver = await startReadyFaceTimeTalkDriver(
      startParams({ videoCaptureBinary: "/libexec/facetime-video-capture" }),
    );

    expect(capture.start).toHaveBeenCalledWith(
      expect.objectContaining({ captureBinary: "/libexec/facetime-video-capture" }),
    );
    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toContain("facetime_look");
    expect(mocks.sessionParams?.instructions).toContain("Vision:");

    await mocks.sessionParams?.onToolCall(look);

    expect(mocks.bridge.sendImage).toHaveBeenCalledWith({ mimeType: "image/jpeg", data: frame });
    expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-look", {
      ok: true,
      frameAttached: true,
      frameAgeMs: expect.any(Number),
    });
    expect(mocks.bridge.sendImage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bridge.submitToolResult.mock.invocationCallOrder[0] ?? 0,
    );
    expect(JSON.stringify(driver.recentTalkEvents)).not.toContain(frame.toString("base64"));
    expect(mocks.consult).not.toHaveBeenCalled();

    await driver.close();
    expect(capture.stop).toHaveBeenCalled();
  });

  it("tells the model why it cannot see instead of sending an old or missing frame", async () => {
    const driver = await startReadyFaceTimeTalkDriver(
      startParams({ videoCaptureBinary: "/libexec/facetime-video-capture" }),
    );
    capture.read.mockReturnValue({ unavailable: "no FaceTime call window is visible" });

    await mocks.sessionParams?.onToolCall(look);

    expect(mocks.bridge.sendImage).not.toHaveBeenCalled();
    expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith("call-look", {
      ok: false,
      error: "no FaceTime call window is visible",
    });
    await driver.close();
  });

  it("keeps a call without sight audio-only: no capture, no tool, no vision prompt", async () => {
    const withoutHelper = await startReadyFaceTimeTalkDriver(startParams());
    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).not.toContain("facetime_look");
    expect(mocks.sessionParams?.instructions).not.toContain("Vision:");
    await withoutHelper.close();

    resetTalkDriverMocks();
    mocks.resolveProvider.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: {},
      capabilities: { supportsVideoFrames: false },
    } as never);
    const warn = vi.fn();
    const audioOnlyModel = await startReadyFaceTimeTalkDriver(
      startParams({
        videoCaptureBinary: "/libexec/facetime-video-capture",
        logger: { ...console, warn },
      }),
    );

    expect(capture.start).not.toHaveBeenCalled();
    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).not.toContain("facetime_look");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot receive images"));
    await audioOnlyModel.close();
  });

  it("drives the avatar from the call's activation and playback, and idles it when media stops", async () => {
    const avatar = { setCallActive: vi.fn(), speak: vi.fn(), clear: vi.fn() };
    const driver = await startReadyFaceTimeTalkDriver(startParams({ avatar }));
    const pumpParams = mocks.pumpParams as unknown as {
      onOutputAudio(audio: Buffer, startsAtMs: number): void;
      onOutputCleared(): void;
    };

    expect(avatar.setCallActive).not.toHaveBeenCalled();
    driver.activate();
    expect(avatar.setCallActive).toHaveBeenLastCalledWith(true);

    pumpParams.onOutputAudio(Buffer.alloc(960), 1_000);
    pumpParams.onOutputCleared();
    expect(avatar.speak).toHaveBeenCalledWith(Buffer.alloc(960), 1_000);
    expect(avatar.clear).toHaveBeenCalledOnce();

    await driver.suspendMedia("test");
    expect(avatar.setCallActive).toHaveBeenLastCalledWith(false);
    await driver.close();
  });
});
