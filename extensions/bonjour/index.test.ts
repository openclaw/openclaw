import type {
  OpenClawGatewayDiscoveryAdvertiseContext,
  OpenClawGatewayDiscoveryService,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const mocks = vi.hoisted(() => ({
  startGatewayBonjourAdvertiser: vi.fn(),
  registerUncaughtExceptionHandler: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
}));

vi.mock("./src/advertiser.js", () => ({
  startGatewayBonjourAdvertiser: mocks.startGatewayBonjourAdvertiser,
}));

vi.mock("openclaw/plugin-sdk/runtime", () => ({
  registerUncaughtExceptionHandler: mocks.registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler: mocks.registerUnhandledRejectionHandler,
}));

const baseContext: OpenClawGatewayDiscoveryAdvertiseContext = {
  machineDisplayName: "Mac Mini",
  gatewayPort: 18789,
  gatewayTlsEnabled: false,
  minimal: false,
};

async function captureAdvertiserOpts(
  pluginConfig: Record<string, unknown> | undefined,
  ctx: OpenClawGatewayDiscoveryAdvertiseContext = baseContext,
): Promise<{ instanceName: unknown }> {
  mocks.startGatewayBonjourAdvertiser.mockReset();
  mocks.startGatewayBonjourAdvertiser.mockResolvedValue({ stop: vi.fn() });

  let registered: OpenClawGatewayDiscoveryService | undefined;
  const api = createTestPluginApi({
    pluginConfig,
    registerGatewayDiscoveryService(service) {
      registered = service;
    },
  });

  const { default: plugin } = await import("./index.js");
  plugin.register(api);
  if (!registered) {
    throw new Error("plugin did not register a gateway discovery service");
  }
  await registered.advertise(ctx);

  const opts = mocks.startGatewayBonjourAdvertiser.mock.calls[0]?.[0];
  return { instanceName: opts?.instanceName };
}

describe("bonjour plugin entry", () => {
  it("falls back to ctx.machineDisplayName when no instanceName is configured", async () => {
    const { instanceName } = await captureAdvertiserOpts(undefined);
    expect(instanceName).toBe("Mac Mini (OpenClaw)");
  });

  it("falls back to ctx.machineDisplayName when pluginConfig.instanceName is empty/whitespace", async () => {
    const { instanceName } = await captureAdvertiserOpts({ instanceName: "   " });
    expect(instanceName).toBe("Mac Mini (OpenClaw)");
  });

  it("uses pluginConfig.instanceName when provided, applying the (OpenClaw) suffix", async () => {
    const { instanceName } = await captureAdvertiserOpts({ instanceName: "AI VA PC" });
    expect(instanceName).toBe("AI VA PC (OpenClaw)");
  });

  it("does not double-suffix when configured value already mentions OpenClaw", async () => {
    const { instanceName } = await captureAdvertiserOpts({ instanceName: "Mac Mini (OpenClaw)" });
    expect(instanceName).toBe("Mac Mini (OpenClaw)");
  });

  it("ignores non-string instanceName values defensively", async () => {
    const { instanceName } = await captureAdvertiserOpts({ instanceName: 42 });
    expect(instanceName).toBe("Mac Mini (OpenClaw)");
  });
});
