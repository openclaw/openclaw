import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it } from "vitest";
import type { Mock } from "vitest";
import { createVoiceCallRuntime } from "./runtime.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

export function registerLiveKitRuntimeTests(mocks: {
  providerStop: Mock;
  livekitBind: Mock;
  livekitRetire: Mock;
  webhookStop: Mock;
  managerStop: Mock;
}) {
  it("joins LiveKit stop before webhook and manager shutdown, including cleanup failure", async () => {
    const config = createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
    config.provider = "livekit";
    config.livekit = {
      url: "wss://livekit.example.test",
      allowInsecureWs: false,
      outboundTrunkId: "ST_out",
      inboundTrunkIds: ["ST_in"],
      roomPrefix: "openclaw-call-",
    };
    config.realtime.enabled = true;
    const runtime = await createVoiceCallRuntime({
      scheduler: createTestPluginServiceScheduler(),
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: {} as never,
    });
    expect(mocks.livekitBind).toHaveBeenCalledOnce();
    expect(mocks.livekitRetire).toHaveBeenCalledOnce();
    const drain = createDeferred<void>();
    mocks.providerStop.mockReturnValue(drain.promise);
    const failure = new Error("Synthetic RTC drain failure");
    const stopping = runtime.stop().catch((error: unknown) => error);
    await Promise.resolve();
    expect(mocks.webhookStop).not.toHaveBeenCalled();
    drain.reject(failure);
    expect(await stopping).toBe(failure);
    expect(mocks.providerStop).toHaveBeenCalledOnce();
    expect(mocks.webhookStop).toHaveBeenCalledOnce();
    expect(mocks.managerStop).toHaveBeenCalledOnce();
  });
}
