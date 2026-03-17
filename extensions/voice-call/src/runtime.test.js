import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
const mocks = vi.hoisted(() => ({
  resolveVoiceCallConfig: vi.fn(),
  validateProviderConfig: vi.fn(),
  managerInitialize: vi.fn(),
  webhookStart: vi.fn(),
  webhookStop: vi.fn(),
  webhookGetMediaStreamHandler: vi.fn(),
  startTunnel: vi.fn(),
  setupTailscaleExposure: vi.fn(),
  cleanupTailscaleExposure: vi.fn()
}));
vi.mock("./config.js", () => ({
  resolveVoiceCallConfig: mocks.resolveVoiceCallConfig,
  validateProviderConfig: mocks.validateProviderConfig
}));
vi.mock("./manager.js", () => ({
  CallManager: class {
    constructor() {
      this.initialize = mocks.managerInitialize;
    }
  }
}));
vi.mock("./webhook.js", () => ({
  VoiceCallWebhookServer: class {
    constructor() {
      this.start = mocks.webhookStart;
      this.stop = mocks.webhookStop;
      this.getMediaStreamHandler = mocks.webhookGetMediaStreamHandler;
    }
  }
}));
vi.mock("./tunnel.js", () => ({
  startTunnel: mocks.startTunnel
}));
vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposure: mocks.setupTailscaleExposure,
  cleanupTailscaleExposure: mocks.cleanupTailscaleExposure
}));
import { createVoiceCallRuntime } from "./runtime.js";
function createBaseConfig() {
  return createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
}
describe("createVoiceCallRuntime lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVoiceCallConfig.mockImplementation((cfg) => cfg);
    mocks.validateProviderConfig.mockReturnValue({ valid: true, errors: [] });
    mocks.managerInitialize.mockResolvedValue(void 0);
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookStop.mockResolvedValue(void 0);
    mocks.webhookGetMediaStreamHandler.mockReturnValue(void 0);
    mocks.startTunnel.mockResolvedValue(null);
    mocks.setupTailscaleExposure.mockResolvedValue(null);
    mocks.cleanupTailscaleExposure.mockResolvedValue(void 0);
  });
  it("cleans up tunnel, tailscale, and webhook server when init fails after start", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(void 0);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));
    await expect(
      createVoiceCallRuntime({
        config: createBaseConfig(),
        coreConfig: {}
      })
    ).rejects.toThrow("init failed");
    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });
  it("returns an idempotent stop handler", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(void 0);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop
    });
    const runtime = await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig: {}
    });
    await runtime.stop();
    await runtime.stop();
    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });
});
