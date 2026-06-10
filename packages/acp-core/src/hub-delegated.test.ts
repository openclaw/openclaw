// Hub-delegated ACP pure-function tests: policy, ownership, lineage, expiry, labels.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_DELEGATED_IDLE_HOURS,
  DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS,
  formatHubDelegatedAutoLabel,
  findHubDelegatedLabelConflictInStore,
  isHubDelegatedAcpSessionEntry,
  isHubDelegatedOwnedByRequester,
  resolveHubDelegatedAcpPolicy,
  resolveHubDelegatedAutoLabel,
  resolveHubDelegatedExpiry,
  resolveHubDelegatedLabelLookup,
  resolveHubDelegatedLineageMismatch,
} from "./hub-delegated.js";

const owner = "agent:main:main";
const marker = { ownerSessionKey: owner, createdAt: 1 };

describe("resolveHubDelegatedAcpPolicy", () => {
  it("uses documented defaults", () => {
    expect(resolveHubDelegatedAcpPolicy()).toEqual({
      idleMs: DEFAULT_HUB_DELEGATED_IDLE_HOURS * 60 * 60 * 1000,
      maxAgeMs: DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS * 60 * 60 * 1000,
    });
  });
});

describe("isHubDelegatedOwnedByRequester", () => {
  it.each([
    ["owner match", { hubDelegated: marker, spawnedBy: owner }, owner, true],
    ["owner without sqlite acp metadata", { hubDelegated: marker, spawnedBy: owner }, owner, true],
    ["unrelated requester", { hubDelegated: marker, spawnedBy: owner }, "agent:peer:main", false],
    [
      "mismatched spawnedBy lineage",
      { hubDelegated: marker, spawnedBy: "agent:attacker:main" },
      "agent:attacker:main",
      false,
    ],
  ] as const)("$name returns ownership=$expected", (name, entry, requester, expected) => {
    expect(isHubDelegatedOwnedByRequester({ entry, requesterSessionKey: requester })).toBe(
      expected,
    );
  });
});

describe("resolveHubDelegatedLineageMismatch", () => {
  it.each([
    [
      "matching lineage",
      { hubDelegated: marker, spawnedBy: owner, parentSessionKey: owner },
      undefined,
    ],
    ["spawnedBy drift", { hubDelegated: marker, spawnedBy: "agent:attacker:main" }, "spawnedBy"],
  ] as const)("detects $0", (_label, entry, expected) => {
    const result = resolveHubDelegatedLineageMismatch(entry);
    if (expected === undefined) {
      expect(result).toBeUndefined();
      return;
    }
    expect(result).toContain(expected);
  });
});

describe("resolveHubDelegatedExpiry", () => {
  const createdAt = 1_000_000;

  it.each([
    [
      "idle expiry",
      { hubDelegated: marker, acp: { lastActivityAt: createdAt, mode: "persistent" as const } },
      { idleMs: 60_000, maxAgeMs: 0 },
      createdAt + 60_001,
      true,
      "delegate-idle-expired",
    ],
    [
      "max age expiry",
      {
        hubDelegated: marker,
        acp: { lastActivityAt: createdAt + 50_000, mode: "persistent" as const },
      },
      { idleMs: 0, maxAgeMs: 60_000 },
      createdAt + 60_001,
      true,
      "delegate-max-age-expired",
    ],
    [
      "recent JSON updatedAt",
      { hubDelegated: marker, updatedAt: createdAt + 50_000 },
      { idleMs: 60_000, maxAgeMs: 0 },
      createdAt + 80_000,
      false,
      undefined,
    ],
  ] as const)("evaluates $0", (_label, entry, policy, now, expired, reason) => {
    const result = resolveHubDelegatedExpiry({ entry, policy, now });
    expect(result.expired).toBe(expired);
    if (expired) {
      expect(result).toMatchObject({ reason });
    }
  });
});

describe("isHubDelegatedAcpSessionEntry", () => {
  it.each([
    ["hubDelegated marker", { hubDelegated: marker }, true],
    ["persistent acp without marker", { acp: { mode: "persistent" as const } }, false],
    [
      "marker with sqlite acp metadata",
      { hubDelegated: marker, acp: { mode: "persistent" } },
      true,
    ],
  ] as const)("detects $0", (_label, entry, expected) => {
    expect(isHubDelegatedAcpSessionEntry(entry)).toBe(expected);
  });
});

describe("findHubDelegatedLabelConflictInStore", () => {
  it("scopes conflicts to the same owner and ignores closed rows without hubDelegated", () => {
    const store = {
      "agent:codex:acp:closed": { label: "refactor", updatedAt: 1 },
      "agent:codex:acp:other-owner": {
        label: "refactor",
        updatedAt: 2,
        hubDelegated: { ownerSessionKey: "agent:main:discord:other", createdAt: 2 },
      },
      "agent:codex:acp:active": {
        label: "refactor",
        updatedAt: 3,
        hubDelegated: { ownerSessionKey: "agent:main:webchat:main", createdAt: 3 },
      },
    };

    expect(
      findHubDelegatedLabelConflictInStore({
        store,
        storeKey: "agent:codex:acp:new",
        ownerSessionKey: "agent:main:webchat:main",
        label: "refactor",
      }),
    ).toBe("agent:codex:acp:active");
    expect(
      findHubDelegatedLabelConflictInStore({
        store: { "agent:codex:acp:closed": { label: "refactor" } },
        storeKey: "agent:codex:acp:reuse-after-close",
        ownerSessionKey: "agent:main:webchat:main",
        label: "refactor",
      }),
    ).toBeUndefined();
  });
});

describe("resolveHubDelegatedLabelLookup", () => {
  const entries = [{ label: "Build" }, { label: "build" }, { label: "refactor" }];

  it.each([
    ["Build", entries, { status: "match", index: 0 }],
    ["build", entries, { status: "match", index: 1 }],
    ["BUILD", entries, { status: "ambiguous", labels: ["Build", "build"] }],
    ["build", [{ label: "Build" }], { status: "missing" }],
  ] as const)("resolves label lookup for $0", (label, lookupEntries, expected) => {
    expect(resolveHubDelegatedLabelLookup({ entries: lookupEntries, label })).toEqual(expected);
  });
});

describe("hub-delegated auto labels", () => {
  it("auto-generates a UTC timestamp label and suffixes on conflict", () => {
    const now = new Date("2026-06-05T14:30:22.000Z");
    expect(formatHubDelegatedAutoLabel(now)).toBe("delegate-20260605-143022");
    expect(
      resolveHubDelegatedAutoLabel({
        now,
        hasLabelConflict: () => false,
      }),
    ).toBe("delegate-20260605-143022");
    expect(
      resolveHubDelegatedAutoLabel({
        now,
        hasLabelConflict: (label) => label === "delegate-20260605-143022",
      }),
    ).toBe("delegate-20260605-143022-2");
  });
});
