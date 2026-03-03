import { resolveControlCommandGate } from "openclaw/plugin-sdk/mattermost";
import { describe, expect, it } from "vitest";
import { resolveMattermostEffectiveAllowFromLists } from "./monitor-auth.js";

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

  it("includes pairing-store in groupAllowFrom for backward compatibility", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["@trusted-user"],
      groupAllowFrom: ["@group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    // Pairing store is included in group auth for backward compatibility
    expect(resolved.effectiveGroupAllowFrom).toEqual(["group-owner", "attacker"]);
  });

  it("inherits pairing-store entries into group allowlist (backward compat)", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      dmPolicy: "pairing",
      allowFrom: ["@trusted-user"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
    // Pairing store is included in group auth for backward compatibility
    expect(resolved.effectiveGroupAllowFrom).toEqual(["trusted-user", "attacker"]);
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
});
