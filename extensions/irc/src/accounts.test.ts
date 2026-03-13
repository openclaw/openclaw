import { describe, expect, it } from "vitest";
import type { CoreConfig } from "./types.js";
import { listIrcAccountIds, resolveDefaultIrcAccountId } from "./accounts.js";

function asConfig(value: unknown): CoreConfig {
  return value as CoreConfig;
}

describe("listIrcAccountIds", () => {
  it("returns default when no accounts are configured", () => {
    expect(listIrcAccountIds(asConfig({}))).toEqual(["default"]);
  });

  it("normalizes, deduplicates, and sorts configured account ids", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          accounts: {
            "Ops Team": {},
            "ops-team": {},
            Work: {},
          },
        },
      },
    });

    expect(listIrcAccountIds(cfg)).toEqual(["ops-team", "work"]);
  });
});

describe("resolveDefaultIrcAccountId", () => {
  it("prefers configured defaultAccount when it matches", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          defaultAccount: "Ops Team",
          accounts: {
            default: {},
            "ops-team": {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("ops-team");
  });

  it("falls back to default when configured defaultAccount is missing", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          defaultAccount: "missing",
          accounts: {
            default: {},
            work: {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("default");
  });

  it("falls back to first sorted account when default is absent", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          accounts: {
            zzz: {},
            aaa: {},
          },
        },
      },
    });

    expect(resolveDefaultIrcAccountId(cfg)).toBe("aaa");
  });
});
