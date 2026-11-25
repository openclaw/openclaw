import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../../test-utils/vitest-spies.js";
import { normalizeFileToolPathParam } from "../../agent-tools.params.js";
import { createSandboxFsBridgeFromResolver } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";

vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  // Node exports this same implementation on native Windows; platform alone
  // would leave the POSIX resolver active on non-Windows test hosts.
  return { ...original, ...original.win32, default: original.win32 };
});

beforeEach(() => mockProcessPlatform("win32"));
afterEach(() => vi.restoreAllMocks());

describe("native Windows file-tool paths", () => {
  const cwd = "C:\\workspace";
  const bridge = createSandboxFsBridgeFromResolver((filePath) => ({
    hostPath: filePath,
    containerPath: filePath,
    relativePath: "note.txt",
  }));

  it.each(["/f/repo/note.txt", "/cygdrive/f/repo/note.txt", "/mnt/f/repo/note.txt"])(
    "resolves %s on the requested drive before local guards and I/O",
    async (input) => {
      const target = "F:\\repo\\note.txt";
      expect(resolveLocalPathToCwd(input, cwd)).toBe(target);
      expect(resolveLocalPathToCwd(`@${input}`, cwd)).toBe(target);
      expect(await normalizeFileToolPathParam(input, cwd)).toBe(target);
      expect(await normalizeFileToolPathParam(`@${input}`, cwd)).toBe(`@${target}`);
      // Injected backends retain their own namespace and resolver.
      expect(resolveToCwd(input, cwd)).toBe(input);
      expect(await normalizeFileToolPathParam(input, cwd, bridge)).toBe(input);
    },
  );

  it.each([
    "/home/user/note.txt",
    "/tmp/note.txt",
    "/mnt/home/note.txt",
    "//server/share/note.txt",
  ])("preserves ordinary absolute path %s", async (input) => {
    expect(resolveLocalPathToCwd(input, cwd)).toBe(input);
    expect(await normalizeFileToolPathParam(input, cwd)).toBe(input);
  });

  it("preserves traversal for the existing containment owner", async () => {
    const input = "/mnt/f/repo/link/../note.txt";
    expect(await normalizeFileToolPathParam(input, cwd)).toBe("F:\\repo\\link\\..\\note.txt");
  });

  it("keeps the same paths literal on POSIX hosts", async () => {
    vi.restoreAllMocks();
    mockProcessPlatform("linux");
    const input = "/mnt/f/repo/note.txt";
    expect(await normalizeFileToolPathParam(input, cwd)).toBe(input);
    expect(path.isAbsolute(input)).toBe(true);
  });
});
