import { resolveControlCommandGate } from "openclaw/plugin-sdk/mattermost";
import { describe, expect, it } from "vitest";
import {
  isMattermostSenderOrChannelAllowed,
  resolveMattermostEffectiveAllowFromLists,
} from "./monitor-auth.js";

describe("mattermost monitor authz", () => {
  it("keeps DM allowlist merged with pairing-store entries", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["@trusted-user"],
      groupAllowFrom: ["@group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
  });

  it("uses explicit groupAllowFrom without pairing-store inheritance", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["@trusted-user"],
      groupAllowFrom: ["@group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("does not inherit pairing-store entries into group allowlist", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["@trusted-user"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["trusted-user"]);
  });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: [],
    });

    const commandGate = resolveControlCommandGate({
      useAccessGroups: true,
      authorizers: [
        { configured: resolved.effectiveAllowFrom.length > 0, allowed: false },
        { configured: resolved.effectiveGroupAllowFrom.length > 0, allowed: false },
      ],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(commandGate.commandAuthorized).toBe(false);
  });

  it("allows group events when allowlist includes the channel id", () => {
    const allowed = isMattermostSenderOrChannelAllowed({
      senderId: "user-123",
      senderName: "alice",
      channelId: "channel-abc",
      allowFrom: ["channel-abc"],
    });

    expect(allowed).toBe(true);
  });

  it("allows group events when allowlist uses channel prefixes", () => {
    const prefixed = isMattermostSenderOrChannelAllowed({
      senderId: "user-123",
      senderName: "alice",
      channelId: "channel-abc",
      allowFrom: ["mattermost:channel:channel-abc"],
    });
    const plainPrefixed = isMattermostSenderOrChannelAllowed({
      senderId: "user-123",
      senderName: "alice",
      channelId: "channel-abc",
      allowFrom: ["channel:channel-abc"],
    });

    expect(prefixed).toBe(true);
    expect(plainPrefixed).toBe(true);
  });

  it("keeps channel allowlist scoped to matching channels", () => {
    const allowed = isMattermostSenderOrChannelAllowed({
      senderId: "user-123",
      senderName: "alice",
      channelId: "channel-other",
      allowFrom: ["channel-abc"],
    });

    expect(allowed).toBe(false);
  });
});
