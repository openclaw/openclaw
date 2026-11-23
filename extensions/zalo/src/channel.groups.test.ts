import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

const MIXED_CASE_GROUP = "zgr-AbC123";

describe("Zalo groups map consumers", () => {
  const cfg = {
    channels: {
      zalo: {
        groups: {
          "*": { tools: { deny: ["browser"] } },
          [MIXED_CASE_GROUP]: { tools: { deny: ["exec"] } },
          "zgr-plain": {},
        },
      },
    },
  } as OpenClawConfig;
  const tools = (groupId: string) =>
    zaloPlugin.groups?.resolveToolPolicy?.({ cfg, groupId, accountId: "default" });

  it("resolves per-group tools from the group id in a real route session key", () => {
    const route = resolveAgentRoute({
      cfg,
      channel: "zalo",
      accountId: "default",
      peer: { kind: "group", id: MIXED_CASE_GROUP },
    });
    // Core looks group tools up by the id inside the session key, which is lowercased.
    const sessionGroupId = route.sessionKey.split(":group:")[1];
    expect(sessionGroupId).toBe(MIXED_CASE_GROUP.toLowerCase());
    expect(tools(sessionGroupId ?? "")).toEqual({ deny: ["exec"] });
    expect(tools(MIXED_CASE_GROUP)).toEqual({ deny: ["exec"] });
  });

  it("falls back to the wildcard entry's tools", () => {
    expect(tools("zgr-plain")).toEqual({ deny: ["browser"] });
    expect(tools("zgr-other")).toEqual({ deny: ["browser"] });
  });

  const skipWarning = (
    params: Omit<
      Parameters<
        NonNullable<
          NonNullable<typeof zaloPlugin.doctor>["shouldSkipDefaultEmptyGroupAllowlistWarning"]
        >
      >[0],
      "channelName"
    >,
  ) =>
    zaloPlugin.doctor?.shouldSkipDefaultEmptyGroupAllowlistWarning?.({
      channelName: "zalo",
      ...params,
    });

  it.each([
    [{ "zgr-listed": {} }, true],
    [{ "zgr-listed": { enabled: false } }, false],
    [{ "*": {} }, false],
    [undefined, false],
  ])("skips the empty group allowlist warning for root groups %j: %s", (groups, expected) => {
    expect(
      skipWarning({
        account: { groupPolicy: "allowlist", ...(groups ? { groups } : {}) },
        prefix: "channels.zalo",
      }),
    ).toBe(expected);
  });

  it.each([
    ["inherits the parent map with one account entry", { work: { groups: {} } }, true],
    [
      "opts out of the parent map with several account entries",
      { work: { groups: {} }, placeholder: { enabled: false } },
      false,
    ],
    ["uses the account map in place of the parent map", { work: { groups: { "*": {} } } }, false],
  ])("for an account that %s", (_label, accounts, expected) => {
    const parent = { groupPolicy: "allowlist", groups: { "zgr-listed": {} }, accounts };
    expect(
      skipWarning({ account: accounts.work, parent, prefix: "channels.zalo.accounts.work" }),
    ).toBe(expected);
  });
});
