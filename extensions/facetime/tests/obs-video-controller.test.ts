import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveFaceTimeConfig } from "../src/config.js";
import { FaceTimeObsVideoController } from "../src/obs-video-controller.js";

function createHarness(
  params: {
    virtualCameraInitiallyActive?: boolean;
    virtualCameraStatusLagReads?: number;
  } = {},
) {
  let virtualCameraActive = params.virtualCameraInitiallyActive ?? false;
  let virtualCameraStarted = false;
  let virtualCameraStatusLagReads = params.virtualCameraStatusLagReads ?? 0;
  let currentScene = "Previous Scene";
  let rendererUrl: string | undefined;
  const call = vi.fn(async (request: string, input?: Record<string, unknown>) => {
    if (request === "GetCurrentProgramScene") {
      return { currentProgramSceneName: currentScene };
    }
    if (request === "GetSceneList") {
      return { scenes: [{ sceneName: "Previous Scene" }] };
    }
    if (request === "GetInputList") {
      return { inputs: [] };
    }
    if (request === "SetCurrentProgramScene") {
      currentScene = String(input?.sceneName);
      return {};
    }
    if (request === "CreateInput") {
      rendererUrl = (input?.inputSettings as { url?: string } | undefined)?.url;
      return {};
    }
    if (request === "GetInputSettings") {
      return { inputSettings: { url: rendererUrl } };
    }
    if (request === "GetVirtualCamStatus") {
      if (virtualCameraStarted && virtualCameraStatusLagReads > 0) {
        virtualCameraStatusLagReads -= 1;
        return { outputActive: false };
      }
      return { outputActive: virtualCameraActive };
    }
    if (request === "StartVirtualCam") {
      virtualCameraStarted = true;
      virtualCameraActive = true;
      return {};
    }
    if (request === "StopVirtualCam") {
      virtualCameraActive = false;
      return {};
    }
    return {};
  });
  const client = {
    connect: vi.fn(async () => ({ negotiatedRpcVersion: 1 })),
    call,
    disconnect: vi.fn(async () => {}),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RuntimeLogger;
  const config = resolveFaceTimeConfig({ video: { enabled: true } }).video;
  return { call, client, config, logger };
}

describe("FaceTime OBS video controller", () => {
  it("owns one browser input, starts the virtual camera, and restores the prior scene", async () => {
    const { call, client, config, logger } = createHarness();
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
    });

    await controller.attach(
      "http://127.0.0.1:18794/avatar/?token=secret",
      { width: 800, height: 600, frameRate: 24 },
      "password",
    );
    await controller.startVirtualCamera();
    expect(client.connect).toHaveBeenCalledWith("ws://127.0.0.1:4455/", "password", {
      rpcVersion: 1,
    });
    expect(call).toHaveBeenCalledWith(
      "CreateInput",
      expect.objectContaining({
        sceneName: "OpenClaw FaceTime Video (test)",
        inputName: "OpenClaw Live Visual (test)",
        inputKind: "browser_source",
        inputSettings: expect.objectContaining({
          url: "http://127.0.0.1:18794/avatar/?token=secret",
          width: 800,
          height: 600,
          reroute_audio: false,
        }),
      }),
    );
    expect(call).toHaveBeenCalledWith("StartVirtualCam");

    await controller.stop();
    expect(call).toHaveBeenCalledWith("RemoveInput", {
      inputName: "OpenClaw Live Visual (test)",
    });
    expect(call).toHaveBeenCalledWith("StopVirtualCam");
    expect(call).toHaveBeenCalledWith("SetCurrentProgramScene", {
      sceneName: "Previous Scene",
    });
    expect(call).toHaveBeenCalledWith("RemoveScene", {
      sceneName: "OpenClaw FaceTime Video (test)",
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("does not stop a virtual camera that was already active", async () => {
    const { call, client, config, logger } = createHarness({
      virtualCameraInitiallyActive: true,
    });
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
    });

    await controller.attach("http://127.0.0.1/avatar/", {
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    await controller.startVirtualCamera();
    await controller.stop();

    expect(call).not.toHaveBeenCalledWith("StartVirtualCam");
    expect(call).not.toHaveBeenCalledWith("StopVirtualCam");
  });

  it("waits for OBS to report an asynchronously started virtual camera", async () => {
    const { call, client, config, logger } = createHarness({
      virtualCameraStatusLagReads: 2,
    });
    const waitForVirtualCameraStatus = vi.fn(async () => {});
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
      waitForVirtualCameraStatus,
    });

    await controller.attach("http://127.0.0.1/avatar/", {
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    await controller.startVirtualCamera();
    await controller.stop();

    expect(waitForVirtualCameraStatus).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenCalledWith("StopVirtualCam");
  });

  it("stops the activation it initiated when readiness never appears", async () => {
    const { call, client, config, logger } = createHarness({
      virtualCameraStatusLagReads: Number.POSITIVE_INFINITY,
    });
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
      waitForVirtualCameraStatus: vi.fn(async () => {}),
    });

    await controller.attach("http://127.0.0.1/avatar/", {
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    await expect(controller.startVirtualCamera()).rejects.toThrow(
      "OBS virtual camera did not start",
    );
    await controller.stop();

    expect(call).toHaveBeenCalledWith("StopVirtualCam");
  });

  it("does not remove a same-name input or scene after renderer ownership changes", async () => {
    const { call, client, config, logger } = createHarness();
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
    });
    await controller.attach("http://127.0.0.1/original/", {
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    call.mockImplementation(async (request: string) => {
      if (request === "GetInputSettings") {
        return { inputSettings: { url: "http://127.0.0.1/replacement/" } };
      }
      if (request === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "OpenClaw FaceTime Video (test)" };
      }
      return {};
    });

    await controller.stop();

    expect(call).not.toHaveBeenCalledWith("RemoveInput", expect.anything());
    expect(call).not.toHaveBeenCalledWith("RemoveScene", expect.anything());
  });

  it("refuses to replace an existing scene with the same per-call name", async () => {
    const { call, client, config, logger } = createHarness();
    call.mockImplementation(async (request: string) => {
      if (request === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "Previous Scene" };
      }
      if (request === "GetSceneList") {
        return { scenes: [{ sceneName: "OpenClaw FaceTime Video (test)" }] };
      }
      return {};
    });
    const controller = new FaceTimeObsVideoController({
      config,
      logger,
      inputName: "OpenClaw Live Visual (test)",
      sceneName: "OpenClaw FaceTime Video (test)",
      client: client as never,
    });

    await expect(
      controller.attach("http://127.0.0.1/avatar/", {
        width: 1280,
        height: 720,
        frameRate: 30,
      }),
    ).rejects.toThrow("OBS scene already exists");
    expect(call).not.toHaveBeenCalledWith("RemoveInput", expect.anything());
  });
});
