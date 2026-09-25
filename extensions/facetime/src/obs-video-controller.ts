import { OBSWebSocket } from "obs-websocket-js";
import type { LiveVisualVideoFormat } from "openclaw/plugin-sdk/live-visual";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeVideoConfig } from "./config.js";

type ObsClient = Pick<OBSWebSocket, "call" | "connect" | "disconnect">;

const VIRTUAL_CAMERA_STATUS_ATTEMPTS = 20;
const VIRTUAL_CAMERA_STATUS_INTERVAL_MS = 50;

function waitForVirtualCameraStatus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, VIRTUAL_CAMERA_STATUS_INTERVAL_MS));
}

/** Owns the plugin-created OBS browser input and virtual-camera lease for one call. */
export class FaceTimeObsVideoController {
  readonly #config: FaceTimeVideoConfig;
  readonly #logger: RuntimeLogger;
  readonly #client: ObsClient;
  readonly #inputName: string;
  readonly #sceneName: string;
  readonly #waitForVirtualCameraStatus: () => Promise<void>;
  #connected = false;
  #inputAttached = false;
  #rendererUrl?: string;
  #previousScene?: string;
  #sceneCreated = false;
  #startedVirtualCamera = false;

  constructor(params: {
    config: FaceTimeVideoConfig;
    logger: RuntimeLogger;
    inputName: string;
    sceneName: string;
    client?: ObsClient;
    waitForVirtualCameraStatus?: () => Promise<void>;
  }) {
    this.#config = params.config;
    this.#logger = params.logger;
    this.#inputName = params.inputName;
    this.#sceneName = params.sceneName;
    this.#client = params.client ?? new OBSWebSocket();
    this.#waitForVirtualCameraStatus =
      params.waitForVirtualCameraStatus ?? waitForVirtualCameraStatus;
  }

  async attach(
    rendererUrl: string,
    video: LiveVisualVideoFormat,
    password?: string,
  ): Promise<void> {
    await this.#client.connect(this.#config.obs.url, password, { rpcVersion: 1 });
    this.#connected = true;

    const current = await this.#client.call("GetCurrentProgramScene");
    this.#previousScene = current.currentProgramSceneName;
    const scenes = await this.#client.call("GetSceneList");
    if (scenes.scenes.some((scene) => scene.sceneName === this.#sceneName)) {
      throw new Error(`OBS scene already exists: ${this.#sceneName}`);
    }
    await this.#client.call("CreateScene", { sceneName: this.#sceneName });
    this.#sceneCreated = true;

    const inputs = await this.#client.call("GetInputList", { inputKind: "browser_source" });
    if (inputs.inputs.some((input) => input.inputName === this.#inputName)) {
      throw new Error(`OBS input already exists: ${this.#inputName}`);
    }
    await this.#client.call("CreateInput", {
      sceneName: this.#sceneName,
      inputName: this.#inputName,
      inputKind: "browser_source",
      inputSettings: {
        url: rendererUrl,
        width: video.width,
        height: video.height,
        reroute_audio: false,
        shutdown: false,
        restart_when_active: true,
      },
      sceneItemEnabled: true,
    });
    this.#inputAttached = true;
    this.#rendererUrl = rendererUrl;
    await this.#client.call("SetCurrentProgramScene", {
      sceneName: this.#sceneName,
    });
    this.#logger.info(`[facetime] attached live visual to OBS scene ${this.#sceneName}`);
  }

  async startVirtualCamera(): Promise<void> {
    if (!this.#connected || !this.#config.obs.autoStartVirtualCamera) {
      return;
    }
    const status = await this.#client.call("GetVirtualCamStatus");
    if (status.outputActive) {
      return;
    }
    await this.#client.call("StartVirtualCam");
    this.#startedVirtualCamera = true;
    for (let attempt = 0; attempt < VIRTUAL_CAMERA_STATUS_ATTEMPTS; attempt += 1) {
      await this.#waitForVirtualCameraStatus();
      const started = await this.#client.call("GetVirtualCamStatus");
      if (started.outputActive) {
        return;
      }
    }
    throw new Error(
      "OBS virtual camera did not start; approve the OBS Camera Extension in macOS System Settings",
    );
  }

  async stop(): Promise<void> {
    if (!this.#connected) {
      return;
    }
    try {
      if (this.#startedVirtualCamera) {
        await this.#client.call("StopVirtualCam").catch(() => undefined);
      }
      let ownsInput = false;
      if (this.#inputAttached) {
        const settings = await this.#client
          .call("GetInputSettings", { inputName: this.#inputName })
          .catch(() => undefined);
        if (settings?.inputSettings.url === this.#rendererUrl) {
          ownsInput = true;
          await this.#client
            .call("RemoveInput", { inputName: this.#inputName })
            .catch(() => undefined);
        }
      }
      if (this.#previousScene && this.#previousScene !== this.#sceneName) {
        const current = await this.#client.call("GetCurrentProgramScene").catch(() => undefined);
        if (current?.currentProgramSceneName === this.#sceneName) {
          await this.#client
            .call("SetCurrentProgramScene", { sceneName: this.#previousScene })
            .catch(() => undefined);
        }
      }
      if (this.#sceneCreated && (!this.#inputAttached || ownsInput)) {
        await this.#client
          .call("RemoveScene", { sceneName: this.#sceneName })
          .catch(() => undefined);
      }
    } finally {
      await this.#client.disconnect().catch(() => undefined);
      this.#connected = false;
      this.#inputAttached = false;
      this.#rendererUrl = undefined;
      this.#sceneCreated = false;
      this.#startedVirtualCamera = false;
    }
  }
}
