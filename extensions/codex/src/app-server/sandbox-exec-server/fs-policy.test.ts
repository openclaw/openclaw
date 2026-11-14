// Model-controlled globs must not stall the Gateway. The legacy regex oracle
// only receives size-capped fuzz inputs to avoid catastrophic backtracking.
import { posix as pathPosix } from "node:path";
import { expect, it } from "vitest";
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

function expectFastMatch(pattern: string, target: string, expected: boolean) {
  const matcher = createGlobReadMatcher(pattern);
  const started = Date.now();
  expect(matcher(target)).toBe(expected);
  expect(Date.now() - started).toBeLessThan(250);
}

function legacyCompileSandboxGlobPattern(pattern: string): RegExp {
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

it.each<[string, string[], string[]]>([
  [
    "/work/private/*.txt",
    ["/work/private/a.txt", "/work/private/.txt"],
    ["/work/private/a/b.txt", "/work/other/a.txt", "/work/private/a.txtx"],
  ],
  ["/work/**/secret", ["/work/secret", "/work/a/b/secret"], ["/work/a/secret/b"]],
  ["/work/**", ["/work/a/b/c"], ["/other/a"]],
  ["/work/**/", ["/work/", "/work/a/"], ["/work"]],
  ["/work/?", ["/work/a"], ["/work/ab", "/work/"]],
  ["/work/[ab].txt", ["/work/a.txt", "/work/b.txt"], ["/work/c.txt"]],
  ["/work/[!ab].txt", ["/work/c.txt"], ["/work/a.txt"]],
  ["/work/[a-b].txt", ["/work/b.txt"], ["/work/c.txt"]],
  ["/work/[]].txt", ["/work/].txt"], ["/work/a.txt"]],
  ["/?", ["/😀"], []],
  ["/*😀", ["/a😀"], ["/a😀b"]],
  ["/[😀]", ["/😀"], ["/a"]],
  ["/*😀😀x", ["/😀😀😀x"], []],
  ["/*\ud83d", ["/\ud83d"], ["/😀"]],
])("matches allowed paths and denies other paths for %s", (pattern, allowed, denied) => {
  const matcher = createGlobReadMatcher(pattern);
  for (const target of allowed) {
    expect(matcher(target), `${pattern}: ${target}`).toBe(true);
  }
  for (const target of denied) {
    expect(matcher(target), `${pattern}: ${target}`).toBe(false);
  }
});

it.each([
  ["/work/[ab", "fs sandbox glob character class must be closed"],
  ["/work/[a/b]", "fs sandbox glob character class cannot match path separators"],
])("fails closed for unsupported character class %s", (pattern, message) => {
  expect(() => createGlobReadMatcher(pattern)).toThrow(message);
});

it("stops globstars at line terminators like the old dot without dotAll", () => {
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    expect(createGlobReadMatcher("/work/**")(`/work/a${terminator}b`)).toBe(false);
    expect(createGlobReadMatcher("/work/**/secret")(`/work/a${terminator}b/secret`)).toBe(false);
  }
  expect(createGlobReadMatcher("/work/**")("/work/a/b")).toBe(true);
  expect(createGlobReadMatcher("/work/**/secret")("/work/a/b/secret")).toBe(true);
  expect(createGlobReadMatcher("/work/*")("/work/a\nb")).toBe(true);
  expect(createGlobReadMatcher("/work/?")("/work/\n")).toBe(true);
  expect(createGlobReadMatcher("/work/[\n]")("/work/\n")).toBe(true);
});

it("rejects a nested star pattern without scanning the whole event loop", () => {
  expectFastMatch(`/${"*a".repeat(14)}`, `/${"a".repeat(29)}x`, false);
  expect(createGlobReadMatcher(`/${"*a".repeat(3)}`)("/xa ya za")).toBe(true);
});

it.each([
  ["overlapping literals", `/*${"a".repeat(100_000)}*`, `/${"a".repeat(200_000)}`],
  ["globstar-slash tokens", `/${"**/".repeat(2000)}`, `/${"a/".repeat(2000)}`],
])("matches repeated %s without rescanning", (_name, pattern, target) => {
  expectFastMatch(pattern, target, true);
});

it("agrees with the legacy regex compiler on small fuzz inputs", () => {
  const atoms = ["a", "b", "/", "\n", "*", "?", "**", "**/", "[a]", "[!a]", "[a-b]", "[]]"];
  const targetTokens = ["a", "b", "-", "]", "/", "\n", "\r", "\u2028", "\u2029"];
  let seed = 0x5eed;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const randomText = (tokens: string[], maxLength: number) => {
    const length = nextRandom() % maxLength;
    return "/" + Array.from({ length }, () => tokens[nextRandom() % tokens.length]).join("");
  };
  for (let round = 0; round < 3000; round += 1) {
    const pattern = randomText(atoms, 10);
    const target = randomText(targetTokens, 14);
    // Mirror policy normalization in the oracle.
    expect(
      createGlobReadMatcher(pattern)(target),
      `pattern ${JSON.stringify(pattern)} target ${JSON.stringify(target)}`,
    ).toBe(
      legacyCompileSandboxGlobPattern(pattern.replace(/\/{2,}/gu, "/")).test(
        pathPosix.normalize(target),
      ),
    );
  }
});
