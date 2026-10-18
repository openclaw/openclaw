// OC Path tests cover oc path parse edges plugin behavior.
import { describe, expect, it } from "vitest";
import { OcPathError, formatOcPath, isPattern, parseOcPath } from "../../oc-path.js";

describe("oc-path-parse-edges", () => {
  it("query without `=` ignored", () => {
    const p = parseOcPath("oc://X.md?nokeyhere");
    expect(p.session).toBeUndefined();
  });

  it("round-trip canonical forms", () => {
    const cases = [
      "oc://SOUL.md",
      "oc://SOUL.md/Boundaries",
      "oc://SOUL.md/Boundaries/deny-rule-1",
      "oc://SOUL.md/Boundaries/deny-rule-1/risk",
      "oc://SOUL.md?session=daily",
      "oc://X.md/a/b/c?session=s",
      "oc://skills/email-drafter/[frontmatter]/name",
      "oc://config/plugins.entries.foo.token",
    ];
    for (const c of cases) {
      expect(formatOcPath(parseOcPath(c)), `round-trip failed for ${c}`).toBe(c);
    }
  });

  it("file slot with `/` round-trips via quoting", () => {
    const constructed = formatOcPath({
      file: "skills/email-drafter",
      section: "Tools",
      item: "-1",
    });
    expect(constructed).toBe('oc://"skills/email-drafter"/Tools/-1');
    const parsed = parseOcPath(constructed);
    expect(parsed.file).toBe("skills/email-drafter");
    expect(parsed.section).toBe("Tools");
    expect(parsed.item).toBe("-1");
  });

  it("formatOcPath rejects field without item or section", () => {
    expect(() => formatOcPath({ file: "X", field: "name" })).toThrow(OcPathError);
    try {
      formatOcPath({ file: "X", field: "name" });
    } catch (err) {
      expect(err).toBeInstanceOf(OcPathError);
      expect((err as OcPathError).code).toBe("OC_PATH_NESTING");
    }
  });

  it("wildcard detection is quote-aware (literal `*` inside quoted segment)", () => {
    const concrete = parseOcPath('oc://config.jsonc/"items.*.glob"');
    expect(isPattern(concrete)).toBe(false);
    const wildcard = parseOcPath("oc://config.jsonc/items/*");
    expect(isPattern(wildcard)).toBe(true);
  });
});
