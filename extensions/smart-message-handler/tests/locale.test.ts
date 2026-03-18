import { describe, it, expect } from "vitest";
import { getLocale } from "../src/locale.ts";
import type { LocaleKey } from "../src/locale.ts";
import type { ExecutionKind } from "../src/types.ts";

const ALL_KINDS: readonly ExecutionKind[] = [
  "search",
  "install",
  "read",
  "run",
  "write",
  "debug",
  "analyze",
  "chat",
  "unknown",
];

describe("getLocale", () => {
  it("returns zh-CN locale by key 'zh-CN'", () => {
    const locale = getLocale("zh-CN");
    expect(locale.kindDescriptions !== undefined).toBe(true);
  });

  it("returns en locale by key 'en'", () => {
    const locale = getLocale("en");
    expect(locale.kindDescriptions !== undefined).toBe(true);
  });

  it("falls back to zh-CN for invalid key", () => {
    const locale = getLocale("fr" as LocaleKey);
    // Should get zh-CN descriptions
    expect(locale.kindDescriptions.chat).toBe("聊天/讨论");
  });
});

describe("locale — kindDescriptions completeness", () => {
  for (const key of ["zh-CN", "en"] as const) {
    it(`${key} has descriptions for all ExecutionKind values`, () => {
      const locale = getLocale(key);
      for (const kind of ALL_KINDS) {
        expect(
          typeof locale.kindDescriptions[kind] === "string" &&
            locale.kindDescriptions[kind].length > 0,
        ).toBe(true);
      }
    });
  }
});
