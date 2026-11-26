import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("registers only an explicitly selected native account route", () => {
  const registerAgentHarness = vi.fn<(harness: AgentHarnessV2) => void>();
  const registerProvider = vi.fn();
  plugin.register(
    createTestPluginApi({ id: "antigravity-native", registerAgentHarness, registerProvider }),
  );
  expect(registerAgentHarness).toHaveBeenCalledTimes(1);
  expect(registerProvider).not.toHaveBeenCalled();
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  expect(harness?.id).toBe("antigravity-native");
  expect(harness?.autoSelection?.providerIds).toEqual([]);
  expect(harness?.authBootstrap).toBe("harness");
  expect(harness?.executionEnvironment).toBe("host-only");
  expect(
    harness?.supports({ requestedRuntime: "antigravity-native", provider: "antigravity-native" }),
  ).toEqual({ supported: true });
  expect(
    harness?.supports({
      requestedRuntime: "antigravity-native",
      provider: "antigravity-native",
      modelProvider: { requestTransportOverrides: "present" },
    }),
  ).toMatchObject({ supported: false });
  expect(harness?.supports({ requestedRuntime: "antigravity-native", provider: "google" })).toEqual(
    {
      supported: false,
      reason: expect.stringContaining("explicit native account route"),
    },
  );
  expect(
    harness?.supports({ requestedRuntime: "auto", provider: "google-antigravity" }),
  ).toMatchObject({
    supported: false,
  });
});
