import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("registers only an explicitly selected native account route", () => {
  const runtime = "antigravity-native";
  const registerAgentHarness = vi.fn<(harness: AgentHarnessV2) => void>();
  const registerProvider = vi.fn();
  plugin.register(createTestPluginApi({ id: runtime, registerAgentHarness, registerProvider }));
  expect(registerAgentHarness).toHaveBeenCalledTimes(1);
  expect(registerProvider).not.toHaveBeenCalled();
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  expect(harness).toMatchObject({
    id: runtime,
    autoSelection: { providerIds: [] },
    authBootstrap: "harness",
    loadModelCatalog: expect.any(Function),
    executionEnvironment: "host-only",
  });
  expect(harness?.supports({ requestedRuntime: runtime, provider: runtime })).toEqual({
    supported: true,
  });
  expect(
    harness?.supports({
      requestedRuntime: runtime,
      provider: runtime,
      modelProvider: { requestTransportOverrides: "present" },
    }),
  ).toMatchObject({ supported: false });
  expect(harness?.supports({ requestedRuntime: runtime, provider: "google" })).toEqual({
    supported: false,
    reason: expect.stringContaining("explicit native account route"),
  });
  expect(
    harness?.supports({ requestedRuntime: "auto", provider: "google-antigravity" }),
  ).toMatchObject({
    supported: false,
  });
});
