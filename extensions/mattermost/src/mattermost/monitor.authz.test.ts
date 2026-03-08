import { resolveControlCommandGate } from "openclaw/plugin-sdk/mattermost";
import { describe, expect, it } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostEffectiveAllowFromLists,
} from "./monitor-auth.js";

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  config: {},
};

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

  it("denies group control commands when the sender is outside the allowlist", () => {
    const decision = authorizeMattermostCommandInvocation({
      account: {
        ...accountFixture,
        config: {
          groupPolicy: "allowlist",
          allowFrom: ["trusted-user"],
        },
      },
      cfg: {
        commands: {
          useAccessGroups: true,
        },
      },
      senderId: "attacker",
      senderName: "attacker",
      channelId: "chan-1",
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(decision).toMatchObject({
      ok: false,
      denyReason: "unauthorized",
      kind: "channel",
    });
  });

  it("authorizes group control commands for allowlisted senders", () => {
    const decision = authorizeMattermostCommandInvocation({
      account: {
        ...accountFixture,
        config: {
          groupPolicy: "allowlist",
          allowFrom: ["trusted-user"],
        },
      },
      cfg: {
        commands: {
          useAccessGroups: true,
        },
      },
      senderId: "trusted-user",
      senderName: "trusted-user",
      channelId: "chan-1",
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "general",
        display_name: "General",
      },
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(decision).toMatchObject({
      ok: true,
      commandAuthorized: true,
      kind: "channel",
    });
  });
});
