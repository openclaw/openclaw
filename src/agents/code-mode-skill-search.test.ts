import { describe, expect, it } from "vitest";
import { searchCodeModeSkills, type CodeModeSkill } from "./code-mode-skills.js";

function skill(name: string, description: string): CodeModeSkill {
  return {
    name,
    description,
    location: "/skills/" + name + "/SKILL.md",
    source: { filePath: "/skills/" + name + "/SKILL.md", readContent: "private-body-marker" },
  };
}
const names = (matches: ReturnType<typeof searchCodeModeSkills>) =>
  matches.map((match) => match.name);

describe("local skill search", () => {
  it.each(["release", "do", "!!!"])(
    "honors an exact name even when lexical ranking cannot (%s)",
    (name) => {
      const catalog = [skill("other", name), skill(name, "A detailed procedure. ".repeat(50))];
      expect(
        names(searchCodeModeSkills(catalog, " " + name.toUpperCase() + " ", { limit: 1 })),
      ).toEqual([name]);
    },
  );
  it("uses shared stemming and keeps literal intent ahead of related expansions", () => {
    const catalog = [
      skill("calendar", "Schedule recurring appointments"),
      skill("web", "Search browse lookup online web"),
      skill("pricing", "Price comparison"),
    ];
    expect(names(searchCodeModeSkills(catalog, "scheduling"))).toEqual(["calendar"]);
    expect(names(searchCodeModeSkills(catalog, "price", { limit: 1 }))).toEqual(["pricing"]);
  });
  it.each(["", "and the", "xylophone", "private-body-marker"])(
    "returns no arbitrary fallback for %s",
    (query) => {
      expect(searchCodeModeSkills([skill("release", "Publishing checks")], query)).toEqual([]);
    },
  );
  it("bounds result count and breaks ties independently of source order", () => {
    const catalog = Array.from({ length: 25 }, (_, n) =>
      skill("guide-" + String(n).padStart(2, "0"), "Scheduling reference"),
    );
    const expected = catalog.slice(0, 5).map((entry) => entry.name);
    expect(names(searchCodeModeSkills(catalog, "scheduling"))).toEqual(expected);
    expect(names(searchCodeModeSkills(catalog.toReversed(), "scheduling"))).toEqual(expected);
    expect(searchCodeModeSkills(catalog, "scheduling", { limit: 20 })).toHaveLength(20);
  });
  it("indexes complete descriptions while returning bounded metadata, not instructions", () => {
    const catalog = [skill("reference", "a".repeat(499) + "🦞 hiddenkeyword")];
    const [match] = searchCodeModeSkills(catalog, "hiddenkeyword");
    expect(match).toEqual({
      name: "reference",
      description: "a".repeat(499),
      location: catalog[0]!.location,
    });
  });
  it("does not reuse a stale index when the prepared catalog is replaced", () => {
    const first = [skill("guide", "Database repair")];
    const next = [skill("guide", "Release verification")];
    expect(names(searchCodeModeSkills(first, "database"))).toEqual(["guide"]);
    expect(searchCodeModeSkills(next, "database")).toEqual([]);
    expect(names(searchCodeModeSkills(next, "release"))).toEqual(["guide"]);
  });
  it.each([0, -1, 1.5, 21, "1", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid result limit %s",
    (limit) => {
      expect(() => searchCodeModeSkills([], "release", { limit })).toThrow(
        "integer between 1 and 20",
      );
    },
  );
  it("rejects invalid or oversized queries and non-object options", () => {
    for (const query of [undefined, 42, "a".repeat(4097)]) {
      expect(() => searchCodeModeSkills([], query)).toThrow("at most 4096");
    }
    for (const options of [null, [], "options"]) {
      expect(() => searchCodeModeSkills([], "release", options)).toThrow("must be an object");
    }
  });
});
