import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCrabboxBinary, resolveCrabboxBinary } from "./crabbox-binary.js";
import { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");

describe("Crabbox binary resolution", () => {
  it("prefers explicit, then sibling, then PATH, then the bare command", () => {
    const toolsDir = path.resolve(path.sep, "tools");
    const pathBinary = path.join(toolsDir, "crabbox");
    const relativePathBinary = path.resolve("relative-tools", "crabbox");
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      resolveCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBe(explicitBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: toolsDir,
        isExecutable: (candidate) => candidate === SIBLING_BINARY || candidate === pathBinary,
      }),
    ).toBe(SIBLING_BINARY);
    expect(
      resolveCrabboxBinary({
        pathEnv: toolsDir,
        isExecutable: (candidate) => candidate === SIBLING_BINARY || candidate === pathBinary,
      }),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: [path.resolve(path.sep, "not-executable"), toolsDir].join(path.delimiter),
        isExecutable: (candidate) => candidate === pathBinary,
      }),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "relative-tools",
        isExecutable: (candidate) => candidate === relativePathBinary,
      }),
    ).toBe(relativePathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBe("crabbox");
  });

  it.each([
    { extensions: ["", ".com", ".bat", ".cmd", ".exe"], preferred: ".exe" },
    { extensions: ["", ".com", ".bat", ".cmd"], preferred: ".cmd" },
    { extensions: ["", ".com", ".bat"], preferred: ".bat" },
    { extensions: ["", ".com"], preferred: ".com" },
    { extensions: [""], preferred: "" },
  ])("selects the preferred Windows executable suffix $preferred", ({ extensions, preferred }) => {
    const toolsDir = path.resolve(path.sep, "tools");
    const pathBinary = path.join(toolsDir, "crabbox");
    const executables = new Set(
      [SIBLING_BINARY, pathBinary].flatMap((binary) =>
        extensions.map((extension) => `${binary}${extension}`),
      ),
    );
    const discovery = {
      platform: "win32" as const,
      pathEnv: toolsDir,
      isExecutable: (candidate: string) => executables.has(candidate),
    };

    expect(resolveCrabboxBinary(discovery)).toBe(`${pathBinary}${preferred}`);
    expect(resolveCrabboxBinary({ ...discovery, openclawRoot: OPENCLAW_ROOT })).toBe(
      `${SIBLING_BINARY}${preferred}`,
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

    expect(
      findCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBeUndefined();
    expect(
      findCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBeUndefined();
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
