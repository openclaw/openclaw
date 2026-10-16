import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCrabboxBinary, resolveCrabboxBinary } from "./crabbox-binary.js";
import { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const toolsDir = path.resolve(path.sep, "tools");
const pathBinary = path.join(toolsDir, "crabbox");

function discover(executables: string[], options: Parameters<typeof resolveCrabboxBinary>[0] = {}) {
  return {
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: toolsDir,
    isExecutable: (candidate: string) => executables.includes(candidate),
    ...options,
  };
}

describe("Crabbox binary resolution", () => {
  it("prefers explicit, then sibling, then PATH, then the bare command", () => {
    const relativePathBinary = path.resolve("relative-tools", "crabbox");
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(resolveCrabboxBinary(discover([], { explicit: explicitBinary }))).toBe(explicitBinary);
    expect(resolveCrabboxBinary(discover([SIBLING_BINARY, pathBinary]))).toBe(SIBLING_BINARY);
    expect(
      resolveCrabboxBinary(discover([SIBLING_BINARY, pathBinary], { openclawRoot: undefined })),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary(
        discover([pathBinary], {
          pathEnv: [path.resolve(path.sep, "not-executable"), toolsDir].join(path.delimiter),
        }),
      ),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary(discover([relativePathBinary], { pathEnv: "relative-tools" })),
    ).toBe(relativePathBinary);
    expect(resolveCrabboxBinary(discover([]))).toBe("crabbox");
  });

  it("prefers Windows executables to command scripts in sibling and PATH discovery", () => {
    const executables = [SIBLING_BINARY, pathBinary].flatMap((binary) =>
      ["", ".com", ".bat", ".cmd", ".exe"].map((extension) => `${binary}${extension}`),
    );
    const discovery = discover(executables, { platform: "win32" });
    expect(resolveCrabboxBinary(discovery)).toBe(`${SIBLING_BINARY}.exe`);
    expect(resolveCrabboxBinary({ ...discovery, openclawRoot: undefined })).toBe(
      `${pathBinary}.exe`,
    );
  });

  it("preserves Windows PATH directory order ahead of executable suffix preference", () => {
    const first = path.resolve(path.sep, "first-tools");
    const second = path.resolve(path.sep, "second-tools");
    const firstBinary = path.join(first, "crabbox.cmd");
    const secondBinary = path.join(second, "crabbox.exe");
    const executables = new Set([firstBinary, secondBinary]);

    expect(
      resolveCrabboxBinary({
        platform: "win32",
        pathEnv: `${first};${second}`,
        isExecutable: (candidate) => executables.has(candidate),
      }),
    ).toBe(firstBinary);
  });

  it("distinguishes executable discovery from the dispatch fallback", () => {
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(findCrabboxBinary(discover([], { explicit: explicitBinary }))).toBeUndefined();
    expect(findCrabboxBinary(discover([]))).toBeUndefined();
  });

  it("derives the package root from source and bundled plugin roots", () => {
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "dist", "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
  });
});
