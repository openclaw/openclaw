import { resolveControlCommandGate } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { resolvePumbleEffectiveAllowFromLists } from "./monitor-auth.js";

describe("pumble monitor authz", () => {
  it("keeps DM allowlist merged with pairing-store entries", () => {
    const resolved = resolvePumbleEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["user:trusted-user"],
      groupAllowFrom: ["user:group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
  });

  it("uses explicit groupAllowFrom without pairing-store inheritance", () => {
    const resolved = resolvePumbleEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["user:trusted-user"],
      groupAllowFrom: ["user:group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("does not inherit pairing-store entries into group allowlist", () => {
    const resolved = resolvePumbleEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["user:trusted-user"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["trusted-user"]);
  });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const resolved = resolvePumbleEffectiveAllowFromLists({
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
});
