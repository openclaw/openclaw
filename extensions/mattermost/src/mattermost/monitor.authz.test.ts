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
});
