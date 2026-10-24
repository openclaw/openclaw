// Voice Call tests cover how runtime config reaches the carrier provider.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { createExternalProviderConfig } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  telnyxProviderCtorArgs: [] as unknown[][],
  webhookStartError: new Error("webhook start stubbed"),
}));

vi.mock("./providers/telnyx.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/telnyx.js")>();
  return {
    ...actual,
    TelnyxProvider: class extends actual.TelnyxProvider {
      constructor(...args: ConstructorParameters<typeof actual.TelnyxProvider>) {
        super(...args);
        mocks.telnyxProviderCtorArgs.push(args);
      }
    },
  };
});

// mock-isolation: Stop at webhook start so the runtime never binds a port; the provider is built first.
vi.mock("./webhook.js", () => ({
  VoiceCallWebhookServer: class {
    start = () => Promise.reject(mocks.webhookStartError);
  },
}));

import { createVoiceCallRuntime } from "./runtime.js";

describe("createVoiceCallRuntime Telnyx provider config", () => {
  it("passes telnyx.noiseSuppression through to the provider", async () => {
    const config = createExternalProviderConfig({ provider: "telnyx" });
    config.telnyx = {
      ...config.telnyx,
      noiseSuppression: { direction: "outbound", engine: "Krisp" },
    };

    await expect(
      createVoiceCallRuntime({
        scheduler: createTestPluginServiceScheduler(),
        config,
        coreConfig: {} as OpenClawConfig,
        agentRuntime: {} as never,
      }),
    ).rejects.toBe(mocks.webhookStartError);

    expect(mocks.telnyxProviderCtorArgs).toEqual([
      [
        {
          apiKey: "key",
          connectionId: "conn",
          publicKey: "pub",
          noiseSuppression: { direction: "outbound", engine: "Krisp" },
        },
        { skipVerification: false },
      ],
    ]);
  });
});
