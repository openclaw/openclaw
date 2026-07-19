// Irc tests cover policy plugin behavior.
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { describe, expect, it } from "vitest";
import {
  resolveIrcGroupMatch,
  resolveIrcGroupRequireMention,
  resolveIrcGroupToolPolicy,
} from "./policy.js";

describe("irc policy", () => {
  it("matches direct and wildcard group entries", () => {
    const direct = resolveIrcGroupMatch({
      groups: {
        "#ops": { requireMention: false },
      },
      target: "#ops",
    });
    expect(direct.allowed).toBe(true);
    expect(
      resolveIrcGroupRequireMention({
        groups: { "#ops": { requireMention: false } },
        target: "#ops",
      }),
    ).toBe(false);

    const wildcard = resolveIrcGroupMatch({
      groups: {
        "*": { requireMention: true },
      },
      target: "#random",
    });
    expect(wildcard.allowed).toBe(true);
    expect(
      resolveIrcGroupRequireMention({
        groups: { "*": { requireMention: true } },
        target: "#random",
      }),
    ).toBe(true);
  });

  it("keeps case-insensitive group matching aligned with shared channel policy resolution", () => {
    const groups = {
      "#Ops": { requireMention: false },
      "#Hidden": { enabled: false },
      "*": { requireMention: true },
    };

    const inboundDirect = resolveIrcGroupMatch({ groups, target: "#ops" });
    const sharedDirect = resolveChannelGroupPolicy({
      cfg: { channels: { irc: { groups } } },
      channel: "irc",
      groupId: "#ops",
      groupIdCaseInsensitive: true,
    });
    expect(sharedDirect.allowed).toBe(inboundDirect.allowed);
    expect(sharedDirect.groupConfig?.requireMention).toBe(
      inboundDirect.groupConfig?.requireMention,
    );

    const inboundDisabled = resolveIrcGroupMatch({ groups, target: "#hidden" });
    const sharedDisabled = resolveChannelGroupPolicy({
      cfg: { channels: { irc: { groups } } },
      channel: "irc",
      groupId: "#hidden",
      groupIdCaseInsensitive: true,
    });
    expect(sharedDisabled.allowed).toBe(inboundDisabled.allowed);
    expect(inboundDisabled.groupConfig?.enabled).toBe(false);
  });

  it("uses exact keys before case-insensitive matches", () => {
    const groups = {
      "#Ops": { requireMention: false },
      "#ops": { requireMention: true },
    };

    expect(resolveIrcGroupRequireMention({ groups, target: "#ops" })).toBe(true);
  });

  it("applies sender policies before falling through to wildcard tools", () => {
    const groups = {
      "#ops": { toolsBySender: { "*": { allow: ["sessions.list"] } } },
      "*": { requireMention: false, tools: { deny: ["exec"] } },
    };

    expect(resolveIrcGroupRequireMention({ groups, target: "#ops" })).toBe(false);
    expect(resolveIrcGroupToolPolicy({ groups, target: "#ops" })).toEqual({
      allow: ["sessions.list"],
    });
  });

  it("matches channel-prefixed senders against the admitted source provider", () => {
    const groups = {
      "#ops": {
        tools: { deny: ["exec"] },
        toolsBySender: {
          "channel:discord:alice": { allow: ["sessions.list"] },
        },
      },
    };

    expect(
      resolveIrcGroupToolPolicy({
        groups,
        target: "#ops",
        senderMessageProvider: "discord",
        senderId: "alice",
      }),
    ).toEqual({ allow: ["sessions.list"] });
    expect(resolveIrcGroupToolPolicy({ groups, target: "#ops", senderId: "alice" })).toEqual({
      deny: ["exec"],
    });
    expect(
      resolveIrcGroupToolPolicy({
        groups,
        target: "#ops",
        senderMessageProvider: null,
        senderId: "alice",
      }),
    ).toEqual({ deny: ["exec"] });
  });
});
