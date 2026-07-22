// Mattermost tests cover message tool discovery behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { mattermostPlugin } from "./channel.js";

describe("mattermost describeMessageTool with an unresolved SecretRef", () => {
  const cfg = {
    channels: {
      mattermost: {
        enabled: true,
        accounts: {
          broken: {
            enabled: true,
            botToken: { source: "env", provider: "default", id: "OPENCLAW_TEST_MISSING_MM" },
            baseUrl: "https://mm.example.com",
          },
          healthy: {
            enabled: true,
            botToken: "mm-healthy-token",
            baseUrl: "https://mm.example.com",
          },
        },
      },
    },
  } as OpenClawConfig;

  it("keeps healthy accounts' message actions discoverable instead of throwing", () => {
    const discovery = mattermostPlugin.actions?.describeMessageTool({ cfg });
    expect(discovery?.actions).toEqual(expect.arrayContaining(["send", "react"]));
  });

  it("reports no actions for a broken account instead of throwing", () => {
    const discovery = mattermostPlugin.actions?.describeMessageTool({ cfg, accountId: "broken" });
    expect(discovery?.actions).toEqual([]);
  });
});
