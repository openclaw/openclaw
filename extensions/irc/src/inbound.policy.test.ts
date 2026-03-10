import { describe, expect, it } from "vitest";
import { __testing } from "./inbound.js";

describe("irc inbound policy", () => {
  it("disables block streaming by default to preserve full final replies", () => {
    expect(
      __testing.resolveIrcDisableBlockStreaming({
        config: {},
      } as never),
    ).toBe(true);
  });

  it("allows explicitly enabled IRC block streaming", () => {
    expect(
      __testing.resolveIrcDisableBlockStreaming({
        config: { blockStreaming: true },
      } as never),
    ).toBe(false);
  });

  it("keeps DM allowlist merged with pairing-store entries", () => {
    const resolved = __testing.resolveIrcEffectiveAllowlists({
      configAllowFrom: ["owner"],
      configGroupAllowFrom: [],
      storeAllowList: ["paired-user"],
      dmPolicy: "pairing",
    });

    expect(resolved.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
  });

  it("does not grant group access from pairing-store when explicit groupAllowFrom exists", () => {
    const resolved = __testing.resolveIrcEffectiveAllowlists({
      configAllowFrom: ["owner"],
      configGroupAllowFrom: ["group-owner"],
      storeAllowList: ["paired-user"],
      dmPolicy: "pairing",
    });

    expect(resolved.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("does not grant group access from pairing-store when groupAllowFrom is empty", () => {
    const resolved = __testing.resolveIrcEffectiveAllowlists({
      configAllowFrom: ["owner"],
      configGroupAllowFrom: [],
      storeAllowList: ["paired-user"],
      dmPolicy: "pairing",
    });

    expect(resolved.effectiveGroupAllowFrom).toEqual([]);
  });
});
