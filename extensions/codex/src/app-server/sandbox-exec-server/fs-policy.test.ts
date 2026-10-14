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

function legacyCompileSandboxGlobCharacterClass(
  pattern: string,
  startIndex: number,
): { source: string; endIndex: number } {
  let index = startIndex + 1;
  if (index >= pattern.length) {
    throw new Error("fs sandbox glob character class must be closed.");
  }
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  let body = "";
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && body) {
      return {
        source: `[${negated ? "^" : ""}${body}]`,
        endIndex: index,
      };
    }
    if (!char || char === "/") {
      throw new Error("fs sandbox glob character class cannot match path separators.");
    }
    body +=
      char === "\\" || char === "]" || (body.length === 0 && char === "^") ? `\\${char}` : char;
  }
  throw new Error("fs sandbox glob character class must be closed.");
}

function legacyCompileSandboxGlobPattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const compiledClass = legacyCompileSandboxGlobCharacterClass(pattern, index);
      source += compiledClass.source;
      index = compiledClass.endIndex;
    } else {
      source += char?.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&") ?? "";
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

describe("sandbox fs glob matching", () => {
  it("matches single-segment stars without crossing separators", () => {
    const matcher = createGlobReadMatcher("/work/private/*.txt");
    expect(matcher("/work/private/a.txt")).toBe(true);
    expect(matcher("/work/private/.txt")).toBe(true);
    expect(matcher("/work/private/a/b.txt")).toBe(false);
    expect(matcher("/work/other/a.txt")).toBe(false);
    expect(matcher("/work/private/a.txtx")).toBe(false);
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
    const question = createGlobReadMatcher("/work/?");
    expect(question("/work/a")).toBe(true);
    expect(question("/work/ab")).toBe(false);
    expect(question("/work/")).toBe(false);

    const classMatcher = createGlobReadMatcher("/work/[ab].txt");
    expect(classMatcher("/work/a.txt")).toBe(true);
    expect(classMatcher("/work/b.txt")).toBe(true);
    expect(classMatcher("/work/c.txt")).toBe(false);

    const negated = createGlobReadMatcher("/work/[!ab].txt");
    expect(negated("/work/c.txt")).toBe(true);
    expect(negated("/work/a.txt")).toBe(false);

    const ranged = createGlobReadMatcher("/work/[a-b].txt");
    expect(ranged("/work/b.txt")).toBe(true);
    expect(ranged("/work/c.txt")).toBe(false);

    const bracket = createGlobReadMatcher("/work/[]].txt");
    expect(bracket("/work/].txt")).toBe(true);
    expect(bracket("/work/a.txt")).toBe(false);
  });

  it("fails closed for unsupported character classes", () => {
    expect(() => createGlobReadMatcher("/work/[ab")).toThrow(
      "fs sandbox glob character class must be closed",
    );
    expect(() => createGlobReadMatcher("/work/[a/b]")).toThrow(
      "fs sandbox glob character class cannot match path separators",
    );
  });

  it("matches literal runs only at reachable positions", () => {
    const matcher = createGlobReadMatcher("/work/file.txt");
    expect(matcher("/work/file.txt")).toBe(true);
    expect(matcher("/work/file.txtx")).toBe(false);
    expect(matcher("/work/sub/file.txt")).toBe(false);
    expect(createGlobReadMatcher("/*ababac/end")("/ababababac/end")).toBe(true);
    expect(createGlobReadMatcher("/**/aba/end")("/aaba/end")).toBe(false);
    expect(createGlobReadMatcher("/**/aba/end")("/x/aba/end")).toBe(true);
  });

  it("keeps unicode code-point semantics from the u-flag regex", () => {
    expect(createGlobReadMatcher("/?")("/😀")).toBe(true);
    expect(createGlobReadMatcher("/*😀")("/a😀")).toBe(true);
    expect(createGlobReadMatcher("/*😀")("/a😀b")).toBe(false);
    expect(createGlobReadMatcher("/[😀]")("/😀")).toBe(true);
    expect(createGlobReadMatcher("/[😀]")("/a")).toBe(false);
    expect(createGlobReadMatcher("/*😀😀x")("/😀😀😀x")).toBe(true);
    expect(createGlobReadMatcher("/*\ud83d")("/😀")).toBe(false);
    expect(createGlobReadMatcher("/*\ud83d")("/\ud83d")).toBe(true);
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

  it("matches a repeated star literal in one pass per segment", () => {
    const path = "ab".repeat(10_000);
    const matcher = createGlobReadMatcher("/*a*");
    const started = Date.now();
    expect(matcher(`/${path}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);

    const missStarted = Date.now();
    expect(matcher(`/${"b".repeat(10_000)}`)).toBe(false);
    expect(Date.now() - missStarted).toBeLessThan(250);
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
    const patternTokens = [
      "a",
      "b",
      "/",
      "\n",
      "*",
      "?",
      "**",
      "**/",
      "[a]",
      "[!a]",
      "[a-b]",
      "[]]",
    ];
    const targetTokens = ["a", "b", "-", "]", "/", "\n", "\r", "\u2028", "\u2029"];
    let seed = 0x5eed;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 3000; round += 1) {
      let pattern = "/";
      const patternLength = nextRandom() % 10;
      for (let index = 0; index < patternLength; index += 1) {
        pattern += patternTokens[nextRandom() % patternTokens.length];
      }
      let target = "/";
      const targetLength = nextRandom() % 14;
      for (let index = 0; index < targetLength; index += 1) {
        target += targetTokens[nextRandom() % targetTokens.length];
      }
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
