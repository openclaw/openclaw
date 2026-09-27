// Line tests cover doctor empty group allowlist behavior.
import type { ChannelDoctorEmptyAllowlistAccountContext } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { lineDoctor } from "./doctor.js";

function context(
  overrides: Partial<ChannelDoctorEmptyAllowlistAccountContext> & {
    account: Record<string, unknown>;
  },
): ChannelDoctorEmptyAllowlistAccountContext {
  return {
    channelName: "line",
    prefix: "channels.line",
    ...overrides,
  };
}

function shouldSkip(params: ChannelDoctorEmptyAllowlistAccountContext): boolean {
  const hook = lineDoctor.shouldSkipDefaultEmptyGroupAllowlistWarning;
  if (!hook) {
    throw new Error("expected LINE doctor to expose shouldSkipDefaultEmptyGroupAllowlistWarning");
  }
  return hook(params);
}

function extraWarnings(params: ChannelDoctorEmptyAllowlistAccountContext): string[] {
  const collect = lineDoctor.collectEmptyAllowlistExtraWarnings;
  if (!collect) {
    throw new Error("expected LINE doctor to expose collectEmptyAllowlistExtraWarnings");
  }
  return collect(params);
}

describe("line doctor empty group allowlist", () => {
  it("keeps the shared warning when no group carries an allowlist", () => {
    const params = context({
      account: { groupPolicy: "allowlist", groups: { C111: { requireMention: true } } },
    });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("keeps the shared warning when nothing is configured under groups", () => {
    const params = context({ account: { groupPolicy: "allowlist" } });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("silences the shared warning when the defaults entry covers every group", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: { "*": { allowFrom: ["U1"] }, C111: { requireMention: true } },
      },
    });

    expect(shouldSkip(params)).toBe(true);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("names the groups left without an allowlist when only some are covered", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: { C222: { allowFrom: ["U1"] }, C333: { requireMention: true } },
      },
    });

    expect(shouldSkip(params)).toBe(true);
    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C333" has no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under channels.line.groups.<id>.allowFrom, or under channels.line.groups."*".allowFrom to cover every group, or to channels.line.groupAllowFrom.',
    ]);
  });

  it("keeps the shared warning when the only allowlisted group is disabled", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: { C444: { enabled: false, allowFrom: ["U1"] } },
      },
    });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("ignores a disabled group when reporting the ones still dropping messages", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: {
          C222: { allowFrom: ["U1"] },
          C333: { requireMention: true },
          C444: { enabled: false },
        },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C333" has no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under channels.line.groups.<id>.allowFrom, or under channels.line.groups."*".allowFrom to cover every group, or to channels.line.groupAllowFrom.',
    ]);
  });

  it("treats a channel-wide group allowlist as covering every configured group", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["U1"],
        groups: { C333: { requireMention: true } },
      },
    });

    expect(shouldSkip(params)).toBe(true);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("reads the account's own groups instead of the channel-level map", () => {
    const params = context({
      account: { groups: { C333: { requireMention: true } } },
      parent: { groupPolicy: "allowlist", groups: { C222: { allowFrom: ["U1"] } } },
    });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("inherits the channel-level groups when the account authors none", () => {
    const params = context({
      account: {},
      parent: {
        groupPolicy: "allowlist",
        groups: { "*": { allowFrom: ["U1"] } },
      },
    });

    expect(shouldSkip(params)).toBe(true);
  });

  it("blames the group's own entry when it authors the empty allowFrom", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: { "*": { allowFrom: ["U1"] }, C111: { allowFrom: [] } },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list is authored on that entry and overrides every wider list, so add sender IDs there, or remove the allowFrom key to inherit.',
    ]);
  });

  it("blames the group's own entry over a channel-wide allowlist", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["U1"],
        groups: { C111: { allowFrom: [] } },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list is authored on that entry and overrides every wider list, so add sender IDs there, or remove the allowFrom key to inherit.',
    ]);
  });

  it("blames the defaults entry when the empty allowFrom is inherited from it", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["U1"],
        groups: { "*": { allowFrom: [] }, C111: {} },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list comes from channels.line.groups."*".allowFrom, so add sender IDs to that entry, or give the group its own allowFrom.',
    ]);
  });

  it("blames the channel-wide list when the empty allowFrom is inherited from it", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        groups: { C111: {} },
      },
    });

    expect(extraWarnings(params)).toStrictEqual([
      '- channels.line.groups: group "C111" resolves to an empty sender allowlist — messages there are silently dropped. The empty list comes from channels.line.groupAllowFrom, so add sender IDs there, or give the group its own allowFrom.',
    ]);
  });

  it("treats a group disabled through the defaults entry as intentionally off", () => {
    const params = context({
      account: {
        groupPolicy: "allowlist",
        groups: {
          "*": { enabled: false },
          C222: { enabled: true, allowFrom: ["U1"] },
          C333: {},
        },
      },
    });

    expect(shouldSkip(params)).toBe(true);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("stays out of the way unless groups use an allowlist", () => {
    const params = context({
      account: { groupPolicy: "open", groups: { C222: { allowFrom: ["U1"] } } },
    });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });

  it("does not answer for another channel", () => {
    const params = context({
      channelName: "telegram",
      prefix: "channels.telegram",
      account: { groupPolicy: "allowlist", groups: { C222: { allowFrom: ["U1"] } } },
    });

    expect(shouldSkip(params)).toBe(false);
    expect(extraWarnings(params)).toStrictEqual([]);
  });
});
