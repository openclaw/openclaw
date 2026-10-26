import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { vi } from "vitest";

const runtimeModule = await import("./runtime.js");
export const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
export const { handleDiscordMessageAction } = await import("./handle-action.js");

export function discordConfig(actions?: Record<string, boolean>): OpenClawConfig {
  return {
    channels: { discord: { token: "tok", ...(actions ? { actions } : {}) } },
  } as OpenClawConfig;
}
