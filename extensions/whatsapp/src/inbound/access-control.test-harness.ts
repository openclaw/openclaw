// Whatsapp plugin module implements access control harness behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, vi } from "vitest";
import {
  type AsyncMock,
  loadConfigMock,
  readAllowFromStoreMock,
  resetPairingSecurityMocks,
  upsertPairingRequestMock,
} from "../pairing-security.test-harness.js";
import { setWhatsAppRuntime } from "../runtime.js";

export const sendMessageMock = vi.fn() as AsyncMock;
export { readAllowFromStoreMock, upsertPairingRequestMock };

let config: Record<string, unknown> = {};

export function setAccessControlTestConfig(next: Record<string, unknown>): void {
  config = next;
  loadConfigMock.mockReturnValue(config);
}

export function getAccessControlTestConfig(): Record<string, unknown> {
  return config;
}

export function setupAccessControlTestHarness(): void {
  beforeEach(() => {
    setWhatsAppRuntime(createPluginRuntimeMock());
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    };
    sendMessageMock.mockReset().mockResolvedValue(undefined);
    resetPairingSecurityMocks(config);
  });
}
