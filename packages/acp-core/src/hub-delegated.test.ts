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

describe("hub-delegated policy and identity", () => {
  it("uses documented lifecycle defaults", () => {
    expect(resolveHubDelegatedAcpPolicy()).toEqual({
      idleMs: DEFAULT_HUB_DELEGATED_IDLE_HOURS * 60 * 60 * 1000,
      maxAgeMs: DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS * 60 * 60 * 1000,
    });
  });

  it.each([
    ["owner", { hubDelegated: marker, spawnedBy: owner }, owner, true],
    ["unrelated requester", { hubDelegated: marker, spawnedBy: owner }, "agent:peer:main", false],
    [
      "drifted spawnedBy",
      { hubDelegated: marker, spawnedBy: "agent:attacker:main" },
      "agent:attacker:main",
      false,
    ],
  ] as const)("checks requester ownership: %s", (_name, entry, requesterSessionKey, expected) => {
    expect(isHubDelegatedOwnedByRequester({ entry, requesterSessionKey })).toBe(expected);
  });

  it("rejects lineage drift", () => {
    expect(
      resolveHubDelegatedLineageMismatch({
        hubDelegated: marker,
        spawnedBy: owner,
        parentSessionKey: owner,
      }),
    ).toBeUndefined();
    expect(
      resolveHubDelegatedLineageMismatch({
        hubDelegated: marker,
        spawnedBy: "agent:attacker:main",
      }),
    ).toContain("spawnedBy");
  });

  it.each([
    ["marker only", { hubDelegated: marker }, true],
    ["ACP only", { acp: { mode: "persistent" as const } }, false],
    ["marker with ACP", { hubDelegated: marker, acp: { mode: "persistent" as const } }, true],
  ] as const)("detects delegate entries: %s", (_name, entry, expected) => {
    expect(isHubDelegatedAcpSessionEntry(entry)).toBe(expected);
  });
});

describe("hub-delegated expiry", () => {
  const createdAt = 1_000_000;

  it.each([
    [
      "idle",
      { hubDelegated: marker, acp: { lastActivityAt: createdAt, mode: "persistent" as const } },
      { idleMs: 60_000, maxAgeMs: 0 },
      createdAt + 60_001,
      { expired: true, reason: "delegate-idle-expired" },
    ],
    [
      "max age",
      {
        hubDelegated: marker,
        acp: { lastActivityAt: createdAt + 50_000, mode: "persistent" as const },
      },
      { idleMs: 0, maxAgeMs: 60_000 },
      createdAt + 60_001,
      { expired: true, reason: "delegate-max-age-expired" },
    ],
    [
      "recent activity",
      { hubDelegated: marker, updatedAt: createdAt + 50_000 },
      { idleMs: 60_000, maxAgeMs: 0 },
      createdAt + 80_000,
      { expired: false },
    ],
  ] as const)("resolves expiry: %s", (_name, entry, policy, now, expected) => {
    expect(resolveHubDelegatedExpiry({ entry, policy, now })).toMatchObject(expected);
  });
});

describe("hub-delegated labels", () => {
  it("scopes conflicts to active delegates owned by the requester", () => {
    const store = {
      closed: { label: "refactor", updatedAt: 1 },
      other: {
        label: "refactor",
        hubDelegated: { ownerSessionKey: "agent:main:other", createdAt: 2 },
      },
      active: { label: "refactor", hubDelegated: marker },
    };
    const findConflict = (
      candidateStore: Parameters<typeof findHubDelegatedLabelConflictInStore>[0]["store"] = store,
    ) =>
      findHubDelegatedLabelConflictInStore({
        store: candidateStore,
        storeKey: "new",
        ownerSessionKey: owner,
        label: "refactor",
      });

    expect(findConflict()).toBe("active");
    expect(findConflict({ closed: store.closed })).toBeUndefined();
  });

  it.each([
    ["Build", [{ label: "Build" }, { label: "build" }], { status: "match", index: 0 }],
    ["build", [{ label: "Build" }, { label: "build" }], { status: "match", index: 1 }],
    [
      "BUILD",
      [{ label: "Build" }, { label: "build" }],
      { status: "ambiguous", labels: ["Build", "build"] },
    ],
    ["build", [{ label: "Build" }], { status: "missing" }],
  ] as const)("resolves %s with exact-case preference", (label, entries, expected) => {
    expect(resolveHubDelegatedLabelLookup({ entries, label })).toEqual(expected);
  });

  it("generates timestamp labels and suffixes conflicts", () => {
    const now = new Date("2026-06-05T14:30:22.000Z");
    const base = formatHubDelegatedAutoLabel(now);
    expect(base).toBe("delegate-20260605-143022");
    expect(resolveHubDelegatedAutoLabel({ now, hasLabelConflict: () => false })).toBe(base);
    expect(resolveHubDelegatedAutoLabel({ now, hasLabelConflict: (label) => label === base })).toBe(
      `${base}-2`,
    );
  });
});
