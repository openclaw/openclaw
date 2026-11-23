import { resolveChannelGroupToolsPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("Zalo groups map consumers", () => {
  it("resolves per-group tools from the exact entry before the wildcard", () => {
    const cfg = {
      channels: {
        zalo: {
          groups: {
            "*": { tools: { deny: ["browser"] } },
            "zgr-listed": { tools: { deny: ["exec"] } },
            "zgr-plain": {},
          },
        },
      },
    } as OpenClawConfig;
    const tools = (groupId: string) =>
      resolveChannelGroupToolsPolicy({ cfg, channel: "zalo", groupId });
    expect(tools("zgr-listed")).toEqual({ deny: ["exec"] });
    expect(tools("zgr-plain")).toEqual({ deny: ["browser"] });
    expect(tools("zgr-other")).toEqual({ deny: ["browser"] });
  });

  it.each([
    [{ "zgr-listed": {} }, true],
    [{ "zgr-listed": { enabled: false } }, false],
    [{ "*": {} }, false],
    [undefined, false],
  ])("skips the empty group allowlist warning for groups %j: %s", (groups, expected) => {
    expect(
      zaloPlugin.doctor?.shouldSkipDefaultEmptyGroupAllowlistWarning?.({
        account: { groupPolicy: "allowlist", ...(groups ? { groups } : {}) },
        channelName: "zalo",
        prefix: "channels.zalo",
      }),
    ).toBe(expected);
  });
});
