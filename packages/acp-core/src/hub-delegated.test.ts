// Hub-delegated ACP session helper tests.
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
} from "./hub-delegated.js";

describe("resolveHubDelegatedAcpPolicy", () => {
  it("uses documented defaults", () => {
    expect(resolveHubDelegatedAcpPolicy()).toEqual({
      idleMs: DEFAULT_HUB_DELEGATED_IDLE_HOURS * 60 * 60 * 1000,
      maxAgeMs: DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS * 60 * 60 * 1000,
    });
  });
});

describe("isHubDelegatedOwnedByRequester", () => {
  const entry = {
    hubDelegated: { ownerSessionKey: "agent:main:main", createdAt: 1 },
    spawnedBy: "agent:main:main",
    acp: { mode: "persistent" as const, lastActivityAt: 1 },
  };

  it("returns true for the owner", () => {
    expect(
      isHubDelegatedOwnedByRequester({
        entry,
        requesterSessionKey: "agent:main:main",
      }),
    ).toBe(true);
  });

  it("returns true for the owner when sqlite acp metadata is missing", () => {
    expect(
      isHubDelegatedOwnedByRequester({
        entry: {
          hubDelegated: { ownerSessionKey: "agent:main:main", createdAt: 1 },
          spawnedBy: "agent:main:main",
        },
        requesterSessionKey: "agent:main:main",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated requesters", () => {
    expect(
      isHubDelegatedOwnedByRequester({
        entry,
        requesterSessionKey: "agent:peer:main",
      }),
    ).toBe(false);
  });
});

describe("resolveHubDelegatedExpiry", () => {
  it("expires idle delegates after configured idle window", () => {
    const createdAt = 1_000_000;
    const result = resolveHubDelegatedExpiry({
      entry: {
        hubDelegated: { ownerSessionKey: "agent:main:main", createdAt },
        acp: { lastActivityAt: createdAt, mode: "persistent" },
      },
      policy: { idleMs: 60_000, maxAgeMs: 0 },
      now: createdAt + 60_001,
    });
    expect(result.expired).toBe(true);
    if (result.expired) {
      expect(result.reason).toBe("delegate-idle-expired");
    }
  });

  it("expires by max age even with recent activity", () => {
    const createdAt = 1_000_000;
    const result = resolveHubDelegatedExpiry({
      entry: {
        hubDelegated: { ownerSessionKey: "agent:main:main", createdAt },
        acp: { lastActivityAt: createdAt + 50_000, mode: "persistent" },
      },
      policy: { idleMs: 0, maxAgeMs: 60_000 },
      now: createdAt + 60_001,
    });
    expect(result.expired).toBe(true);
    if (result.expired) {
      expect(result.reason).toBe("delegate-max-age-expired");
    }
  });
});

describe("isHubDelegatedAcpSessionEntry", () => {
  it("requires hubDelegated owner", () => {
    expect(
      isHubDelegatedAcpSessionEntry({
        hubDelegated: { ownerSessionKey: "agent:main:main", createdAt: 1 },
      }),
    ).toBe(true);
    expect(
      isHubDelegatedAcpSessionEntry({
        acp: { mode: "persistent" },
      }),
    ).toBe(false);
  });

  it("accepts sqlite acp metadata when present", () => {
    expect(
      isHubDelegatedAcpSessionEntry({
        acp: { mode: "persistent" },
        hubDelegated: { ownerSessionKey: "agent:main:main", createdAt: 1 },
      }),
    ).toBe(true);
  });
});

describe("findHubDelegatedLabelConflictInStore", () => {
  it("scopes conflicts to the same owner and ignores closed rows without hubDelegated", () => {
    const store = {
      "agent:codex:acp:closed": {
        label: "refactor",
        updatedAt: 1,
      },
      "agent:codex:acp:other-owner": {
        label: "refactor",
        updatedAt: 2,
        hubDelegated: {
          ownerSessionKey: "agent:main:discord:other",
          createdAt: 2,
        },
      },
      "agent:codex:acp:active": {
        label: "refactor",
        updatedAt: 3,
        hubDelegated: {
          ownerSessionKey: "agent:main:webchat:main",
          createdAt: 3,
        },
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
        store: {
          "agent:codex:acp:closed": {
            label: "refactor",
          },
        },
        storeKey: "agent:codex:acp:reuse-after-close",
        ownerSessionKey: "agent:main:webchat:main",
        label: "refactor",
      }),
    ).toBeUndefined();
    expect(
      findHubDelegatedLabelConflictInStore({
        store,
        storeKey: "agent:codex:acp:other-owner-new",
        ownerSessionKey: "agent:main:discord:other",
        label: "refactor",
      }),
    ).toBe("agent:codex:acp:other-owner");
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
