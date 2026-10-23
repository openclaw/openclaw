import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import plugin from "./index.js";

export function createRegisteredAcpxService(
  options: Parameters<typeof createTestPluginApi>[0] = {},
) {
  let service: OpenClawPluginService | undefined;
  plugin.register(
    createTestPluginApi({
      id: "acpx",
      runtime: createPluginRuntimeMock(),
      ...options,
      registerService: (registered) => {
        if (registered.apiVersion === 2) {
          throw new Error("Expected ACPX runtime service API version 1");
        }
        service = registered;
      },
    }),
  );
  if (!service) {
    throw new Error("ACPX runtime service is not registered");
  }
  return service;
}
