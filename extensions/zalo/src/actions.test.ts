// Zalo tests cover actions plugin behavior.
import { describe, expect, it } from "vitest";
import { zaloMessageActions } from "./actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("zaloMessageActions.describeMessageTool", () => {
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

    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "work" })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(zaloMessageActions.supportsAction?.({ action: "react" })).toBe(false);
  });
});

describe("zaloMessageActions.describeMessageTool with an unresolved SecretRef", () => {
  const cfg: OpenClawConfig = {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          broken: {
            enabled: true,
            botToken: { source: "env", provider: "default", id: "OPENCLAW_TEST_MISSING_ZALO" },
          },
          healthy: { enabled: true, botToken: "zalo-healthy-token" },
        },
      },
    },
  } as OpenClawConfig;

  it("still advertises send for healthy accounts", () => {
    expect(zaloMessageActions.describeMessageTool?.({ cfg })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
  });

  it("reports no actions for a broken account instead of throwing", () => {
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "broken" })).toBeNull();
  });
});
