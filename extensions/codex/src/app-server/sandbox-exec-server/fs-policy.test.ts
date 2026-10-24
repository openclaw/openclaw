// Sandbox fs glob matching must stay linear: the pattern is model-session
// output and the target path is model-requested, so a backtracking regex is a
// Gateway event-loop freeze. The legacy regex compiler below is kept only as
// a differential oracle; fuzz inputs are size-capped so it cannot backtrack.
import { posix as pathPosix } from "node:path";
import { describe, expect, it } from "vitest";
import { assertResolvedFsSandboxAccess, resolveFsSandboxPolicy } from "./fs-policy.js";

function createGlobReadMatcher(pattern: string): (target: string) => boolean {
  const policy = resolveFsSandboxPolicy(
    { sandbox: { containerWorkdir: "/sandbox" } } as never,
    {
      sandbox: {
        permissions: {
          type: "managed",
          file_system: {
            type: "restricted",
            entries: [{ access: "read", path: { type: "glob_pattern", pattern } }],
          },
        },
      },
    } as never,
  );
  return (target) => {
    try {
      assertResolvedFsSandboxAccess(policy, [{ path: target, access: "read" }]);
      return true;
    } catch {
      return false;
    }
  };
}

function expectMatches(pattern: string, allowed: string[], denied: string[]) {
  const matcher = createGlobReadMatcher(pattern);
  for (const target of allowed) {
    expect(matcher(target), `${pattern}: ${target}`).toBe(true);
  }
  for (const target of denied) {
    expect(matcher(target), `${pattern}: ${target}`).toBe(false);
  }
}

function legacyCompileSandboxGlobPattern(pattern: string): RegExp {
  // This oracle only accepts the fuzz alphabet below, not arbitrary policy input.
  const sources: Record<string, string> = {
    "**/": "(?:.*/)?",
    "**": ".*",
    "*": "[^/]*",
    "?": "[^/]",
    "[a]": "[a]",
    "[!a]": "[^a]",
    "[a-b]": "[a-b]",
    "[]]": "[\\]]",
  };
  const source = pattern.replace(
    /\*\*\/|\*\*|\[!a\]|\[a-b\]|\[\]\]|\[a\]|[\s\S]/gu,
    (token) => sources[token] ?? token.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"),
  );
  return new RegExp(`^${source}$`, "u");
}

describe("sandbox fs glob matching", () => {
  it("matches single-segment stars without crossing separators", () => {
    expectMatches(
      "/work/private/*.txt",
      ["/work/private/a.txt", "/work/private/.txt"],
      ["/work/private/a/b.txt", "/work/other/a.txt", "/work/private/a.txtx"],
    );
  });

  it("matches optional and crossing globstars", () => {
    const optional = createGlobReadMatcher("/work/**/secret");
    expect(optional("/work/secret")).toBe(true);
    expect(optional("/work/a/b/secret")).toBe(true);
    expect(optional("/work/a/secret/b")).toBe(false);

    const crossing = createGlobReadMatcher("/work/**");
    expect(crossing("/work/a/b/c")).toBe(true);
    expect(crossing("/other/a")).toBe(false);

    const trailing = createGlobReadMatcher("/work/**/");
    expect(trailing("/work/")).toBe(true);
    expect(trailing("/work/a/")).toBe(true);
    expect(trailing("/work")).toBe(false);
  });

  it("matches question marks and character classes", () => {
    expectMatches("/work/?", ["/work/a"], ["/work/ab", "/work/"]);
    expectMatches("/work/[ab].txt", ["/work/a.txt", "/work/b.txt"], ["/work/c.txt"]);
    expectMatches("/work/[!ab].txt", ["/work/c.txt"], ["/work/a.txt"]);
    expectMatches("/work/[a-b].txt", ["/work/b.txt"], ["/work/c.txt"]);
    expectMatches("/work/[]].txt", ["/work/].txt"], ["/work/a.txt"]);
  });

  it("fails closed for unsupported character classes", () => {
    expect(() => createGlobReadMatcher("/work/[ab")).toThrow(
      "fs sandbox glob character class must be closed",
    );
    expect(() => createGlobReadMatcher("/work/[a/b]")).toThrow(
      "fs sandbox glob character class cannot match path separators",
    );
  });

  it("keeps unicode code-point semantics from the u-flag regex", () => {
    expectMatches("/?", ["/😀"], []);
    expectMatches("/*😀", ["/a😀"], ["/a😀b"]);
    expectMatches("/[😀]", ["/😀"], ["/a"]);
    expectMatches("/*😀😀x", ["/😀😀😀x"], []);
    expectMatches("/*\ud83d", ["/\ud83d"], ["/😀"]);
  });

  it("stops globstars at line terminators like the old dot without dotAll", () => {
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(createGlobReadMatcher("/work/**")(`/work/a${terminator}b`)).toBe(false);
      expect(createGlobReadMatcher("/work/**/secret")(`/work/a${terminator}b/secret`)).toBe(false);
    }
    expect(createGlobReadMatcher("/work/**")("/work/a/b")).toBe(true);
    expect(createGlobReadMatcher("/work/**/secret")("/work/a/b/secret")).toBe(true);
    // Single stars, question marks, and classes still match line terminators.
    expect(createGlobReadMatcher("/work/*")("/work/a\nb")).toBe(true);
    expect(createGlobReadMatcher("/work/?")("/work/\n")).toBe(true);
    expect(createGlobReadMatcher("/work/[\n]")("/work/\n")).toBe(true);
  });

  it("rejects a nested star pattern without scanning the whole event loop", () => {
    const matcher = createGlobReadMatcher(`/${"*a".repeat(14)}`);
    const target = `/${"a".repeat(29)}x`;
    const started = Date.now();
    expect(matcher(target)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
    expect(createGlobReadMatcher(`/${"*a".repeat(3)}`)("/xa ya za")).toBe(true);
  });

  it("matches long overlapping literals without rescanning each prefix", () => {
    const literal = "a".repeat(100_000);
    const matcher = createGlobReadMatcher(`/*${literal}*`);
    const started = Date.now();
    expect(matcher(`/${literal}${literal}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("matches repeated globstar-slash tokens without rescanning per cursor", () => {
    const matcher = createGlobReadMatcher(`/${"**/".repeat(2000)}`);
    const started = Date.now();
    expect(matcher(`/${"a/".repeat(2000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("agrees with the legacy regex compiler on small fuzz inputs", () => {
    const atoms = ["a", "b", "/", "\n", "*", "?", "**", "**/", "[a]", "[!a]", "[a-b]", "[]]"];
    const targetTokens = ["a", "b", "-", "]", "/", "\n", "\r", "\u2028", "\u2029"];
    let seed = 0x5eed;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const randomText = (tokens: string[], maxLength: number) =>
      "/" +
      Array.from(
        { length: nextRandom() % maxLength },
        () => tokens[nextRandom() % tokens.length],
      ).join("");
    for (let round = 0; round < 3000; round += 1) {
      const pattern = randomText(atoms, 10);
      const target = randomText(targetTokens, 14);
      const matcher = createGlobReadMatcher(pattern);
      // Policy checks run on posix-normalized paths and collapse duplicate
      // separators in patterns, so the oracle must apply the same contract.
      const normalizedPattern = pattern.replace(/\/{2,}/gu, "/");
      const normalizedTarget = pathPosix.normalize(target);
      expect(
        matcher(target),
        `pattern ${JSON.stringify(pattern)} target ${JSON.stringify(target)}`,
      ).toBe(legacyCompileSandboxGlobPattern(normalizedPattern).test(normalizedTarget));
    }
  });
});
