import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeFileReferencePrefix } from "../../sandbox-paths.js";
import { getReadPathVariants, resolveToCwd } from "./path-utils.js";

describe("resolveToCwd", () => {
  const cwd = path.resolve("workspace");

  it.each([
    ["@notes.md", "notes.md"],
    ["@@notes.md", "@notes.md"],
    ["@@@notes.md", "@@notes.md"],
    ["./@notes.md", "@notes.md"],
  ])("consumes one reference prefix across resolver handoffs: %s", (input, filename) => {
    const normalized = normalizeFileReferencePrefix(input);
    expect(resolveToCwd(normalized, cwd)).toBe(path.resolve(cwd, filename));
    expect(resolveToCwd(normalizeFileReferencePrefix(normalized), cwd)).toBe(
      path.resolve(cwd, filename),
    );
  });

  it("preserves home and file URL references without decoding escaped mentions", () => {
    const target = path.resolve(cwd, "notes.txt");
    const url = pathToFileURL(target).href;
    expect(resolveToCwd(normalizeFileReferencePrefix(`@${url}`), cwd)).toBe(target);
    expect(resolveToCwd(normalizeFileReferencePrefix(`@@${url}`), cwd)).toBe(
      path.resolve(cwd, `@${url}`),
    );
    expect(resolveToCwd(normalizeFileReferencePrefix("@~/notes.txt"), cwd)).toBe(
      resolveToCwd("~/notes.txt", cwd),
    );
  });

  it("keeps malformed file URLs on the ordinary relative-path path", () => {
    const malformed = "file://%";
    expect(resolveToCwd(malformed, cwd)).toBe(path.resolve(cwd, malformed));
  });

  it.runIf(process.platform === "win32")(
    "expands a Windows-style home prefix against the OS home",
    () => {
      const homeDir = process.env.HOME ?? os.homedir();
      expect(resolveToCwd("~\\notes.txt", cwd)).toBe(path.resolve(homeDir, "notes.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a backslash-prefixed tilde literal on POSIX",
    () => {
      expect(resolveToCwd("~\\notes.txt", cwd)).toBe(path.resolve(cwd, "~\\notes.txt"));
    },
  );
});

describe("getReadPathVariants", () => {
  it("keeps the parent path unchanged for every filename fallback", () => {
    const cwd = path.resolve("workspace");
    const parent = path.join(cwd, "cafe\u0301 d'accord 9.30 PM\u202Farchive");
    const filePath = path.join(parent, "re\u0301sume\u0301 9.30 PM d'accord.txt");
    const variants = getReadPathVariants(filePath);

    expect(variants.length).toBeGreaterThan(0);
    expect(new Set(variants.map((variant) => path.dirname(variant)))).toEqual(new Set([parent]));
  });
});
