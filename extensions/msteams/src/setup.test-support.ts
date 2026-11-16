import { vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";

export function createMSTeamsTestConfig(msteams: MSTeamsConfig): OpenClawConfig {
  return { channels: { msteams } };
}

export function createMSTeamsSetupPrompter(
  credentials?: readonly [appId: string, appPassword: string, tenantId: string],
) {
  const text = credentials
    ? vi.fn(async ({ message }: { message: string }) => {
        switch (message) {
          case "Enter MS Teams App ID":
            return credentials[0];
          case "Enter MS Teams App Password":
            return credentials[1];
          case "Enter MS Teams Tenant ID":
            return credentials[2];
          default:
            throw new Error(`Unexpected prompt: ${message}`);
        }
      })
    : vi.fn();
  return {
    confirm: vi.fn(async () => !credentials),
    note: vi.fn(async () => {}),
    text,
  };
}
