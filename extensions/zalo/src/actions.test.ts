// Zalo tests cover actions plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("zaloPlugin.actions.describeMessageTool", () => {
  it("honors the selected Zalo account during discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "root-token",
          accounts: {
            default: {
              enabled: false,
              botToken: "default-token",
            },
            work: {
              enabled: true,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(zaloPlugin.actions?.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(zaloPlugin.actions?.describeMessageTool?.({ cfg, accountId: "work" })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    expect(zaloPlugin.actions?.supportsAction?.({ action: "react" })).toBe(false);
  });

  it("keeps healthy account actions when one account SecretRef is unavailable", () => {
    const cfg = {
      channels: {
        zalo: {
          accounts: {
            broken: {
              botToken: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
              },
            },
            healthy: { botToken: "healthy-token" },
          },
        },
      },
    } as OpenClawConfig;
    expect(zaloPlugin.actions?.describeMessageTool?.({ cfg })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloPlugin.actions?.describeMessageTool?.({ cfg, accountId: "broken" })).toBeNull();
  });
});
