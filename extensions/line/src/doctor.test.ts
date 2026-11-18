import type { ChannelDoctorEmptyAllowlistAccountContext } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { lineDoctor } from "./doctor.js";

function context(
  account: Record<string, unknown>,
  parent?: Record<string, unknown>,
): ChannelDoctorEmptyAllowlistAccountContext {
  return { channelName: "line", prefix: "channels.line", account, parent };
}

const shouldSkip = lineDoctor.shouldSkipDefaultEmptyGroupAllowlistWarning!;
const extraWarnings = lineDoctor.collectEmptyAllowlistExtraWarnings!;

describe("line doctor empty group allowlist", () => {
  it.each([
    { groupPolicy: "allowlist" },
    { groupPolicy: "open", groups: { C222: { allowFrom: ["U1"] } } },
  ])("leaves the shared warning alone for $groupPolicy without scoped coverage", (account) => {
    const params = context(account);
    expect({ skip: shouldSkip(params), warnings: extraWarnings(params) }).toStrictEqual({
      skip: false,
      warnings: [],
    });
  });

  it("ignores a disabled group when reporting the ones still dropping messages", () => {
    const params = context({
      groupPolicy: "allowlist",
      groups: {
        C222: { allowFrom: ["U1"] },
        C333: { requireMention: true },
        C444: { enabled: false },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C333" has no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under channels.line.groups.<id>.allowFrom, or under channels.line.groups."*".allowFrom to cover every group, or to channels.line.groupAllowFrom.',
    ]);
  });

  it("inherits the channel-level groups when the account authors none", () => {
    const params = context(
      {},
      {
        groupPolicy: "allowlist",
        groups: { "*": { allowFrom: ["U1"] } },
      },
    );

    expect(shouldSkip(params)).toBe(true);
  });

  it.each([
    {
      source: "group's own entry",
      account: { groups: { "*": { allowFrom: ["U1"] }, C111: { allowFrom: [] } } },
      warning:
        '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list is authored on that entry and overrides every wider list, so add sender IDs there, or remove the allowFrom key to inherit.',
    },
    {
      source: "defaults entry",
      account: { groupAllowFrom: ["U1"], groups: { "*": { allowFrom: [] }, C111: {} } },
      warning:
        '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list comes from channels.line.groups."*".allowFrom, so add sender IDs to that entry, or give the group its own allowFrom.',
    },
    {
      source: "channel-wide list",
      account: { groupAllowFrom: [], groups: { C111: {} } },
      warning:
        '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list comes from channels.line.groupAllowFrom, so add sender IDs there, or give the group its own allowFrom.',
    },
  ])("blames the $source supplying an empty allowFrom", ({ account, warning }) => {
    expect(extraWarnings(context({ groupPolicy: "allowlist", ...account }))).toStrictEqual([
      warning,
    ]);
  });

  it.each(["open", "", " "])("respects an authored non-allowlist policy %j", (groupPolicy) => {
    const params = context(
      { groupPolicy, groups: { C222: { allowFrom: ["U1"] } } },
      { groupPolicy: "allowlist" },
    );

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });
});
