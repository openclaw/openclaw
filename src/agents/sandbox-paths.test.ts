import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  assertSandboxPath,
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
  resolveSandboxPath,
} from "./sandbox-paths.js";

async function withSandboxRoot<T>(run: (sandboxDir: string) => Promise<T>, parent = os.tmpdir()) {
  const sandboxDir = await fs.mkdtemp(path.join(parent, "sandbox-media-"));
  try {
    return await run(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function expectSandboxRejection(media: string, sandboxRoot: string, pattern: RegExp) {
  await expect(resolveSandboxedMediaSource({ media, sandboxRoot })).rejects.toThrow(pattern);
}

function sandboxPath(root: string, filePath: string, allowFinalSymlinkForUnlink?: boolean) {
  return assertSandboxPath({ filePath, cwd: root, root, allowFinalSymlinkForUnlink });
}

async function expectMediaPath(media: string, expected: (root: string) => string) {
  await withSandboxRoot(async (sandboxRoot) => {
    await expect(resolveSandboxedMediaSource({ media, sandboxRoot })).resolves.toBe(
      expected(sandboxRoot),
    );
  });
}

async function expectPathRejection(
  root: string,
  filePath: string,
  pattern = /(?:resolves outside|escapes) sandbox root/i,
) {
  await expect(sandboxPath(root, filePath)).rejects.toThrow(pattern);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function withManagedMediaRoot<T>(run: (ctx: { stateDir: string }) => Promise<T>) {
  return withSandboxRoot(async (stateDir) => {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.join(stateDir, "media", "outbound"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "media", "tool-file-transfer"), { recursive: true });
      return await run({ stateDir });
    });
  });
}

async function withOutsideHardlinkInOpenClawTmp<T>(
  openClawTmpDir: string,
  run: (hardlinkPath: string) => Promise<T>,
): Promise<void> {
  const outsideDir = await fs.mkdtemp(path.join(process.cwd(), "sandbox-media-hardlink-outside-"));
  const outsideFile = path.join(outsideDir, "outside-secret.txt");
  const hardlinkPath = path.join(openClawTmpDir, `hardlink-${process.pid}-${Date.now()}.txt`);
  try {
    if (isPathInside(openClawTmpDir, outsideFile)) {
      return;
    }
    await fs.writeFile(outsideFile, "secret", "utf8");
    await fs.mkdir(openClawTmpDir, { recursive: true });
    try {
      await fs.link(outsideFile, hardlinkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }
    await run(hardlinkPath);
  } finally {
    await fs.rm(hardlinkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}

it("resolveSandboxPath keeps home-sibling roots absolute in escape diagnostics", async () => {
  const home = path.join(os.homedir(), "test-home");
  await withEnvAsync({ HOME: home, OPENCLAW_HOME: undefined }, async () => {
    const root = path.resolve(`${home}-sibling`);
    const outside = path.dirname(root);

    expect(() => resolveSandboxPath({ filePath: outside, cwd: root, root })).toThrow(
      `Path escapes sandbox root (${root}): ${outside}`,
    );
  });
});

describe("assertSandboxPath", () => {
  it("expands file reference prefixes only once", async () => {
    await withSandboxRoot(async (root) => {
      await expect(sandboxPath(root, "@@notes.txt")).resolves.toMatchObject({
        relative: "@notes.txt",
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-then-dot-dot traversal for existing and new files",
    async () => {
      await withSandboxRoot(async (dir) => {
        const parent = await fs.realpath(dir);
        const root = path.join(parent, "workspace");
        const outside = path.join(parent, "outside");
        await fs.mkdir(path.join(root, "sub"), { recursive: true });
        await fs.mkdir(outside);
        await fs.symlink("..", path.join(root, "sub", "up"));
        await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8");

        const escapedRead = `${root}/sub/up/../outside/secret.txt`;
        await expect(fs.readFile(escapedRead, "utf8")).resolves.toBe("outside");
        await expectPathRejection(root, escapedRead);
        await expectPathRejection(root, "sub/up/../outside/secret.txt");
        await expectPathRejection(root, `${root}/sub/up/../outside/new.txt`);
        await expectPathRejection(root, `${root}/sub/up/../..`);

        await fs.mkdir(path.join(root, "a"));
        await fs.mkdir(path.join(root, "b"));
        await fs.symlink("../b", path.join(root, "a", "up"));
        await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf8");
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "a", "inside.txt"));
        const safeRawPath = "a/up/../inside.txt";
        await expect(fs.readFile(`${root}/${safeRawPath}`, "utf8")).resolves.toBe("inside");
        await expectPathRejection(root, safeRawPath, /symlink escapes sandbox root/i);
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape"));
        const escapedFinalSymlink = `${root}/a/up/../escape`;
        await expect(fs.readFile(escapedFinalSymlink, "utf8")).resolves.toBe("outside");
        await expectPathRejection(root, escapedFinalSymlink, /symlink escapes sandbox root/i);

        await fs.symlink(outside, path.join(root, "outside-link"));
        await expect(sandboxPath(root, `${root}/outside-link/`, true)).rejects.toThrow(
          /escapes sandbox root/i,
        );

        await fs.mkdir(path.join(root, "real"));
        await fs.symlink(path.join(root, "real"), path.join(root, "in-root-link"));
        await expect(
          sandboxPath(root, `${root}/in-root-link/../real/new.txt`),
        ).resolves.toBeTruthy();
        await expect(sandboxPath(root, root)).resolves.toBeTruthy();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not trust unrelated ancestors of a cwd alias pointing deeper into the root",
    async () => {
      await withSandboxRoot(async (dir) => {
        const parent = await fs.realpath(dir);
        const root = path.join(parent, "workspace");
        const unrelated = path.join(parent, "unrelated");
        const cwd = path.join(unrelated, "cwd");
        await fs.mkdir(path.join(root, "nested"), { recursive: true });
        await fs.mkdir(unrelated);
        await fs.symlink(path.join(root, "nested"), cwd);
        await fs.writeFile(path.join(root, "proof.txt"), "inside");
        const externalInput = path.join(unrelated, "proof.txt");
        await fs.symlink(path.join(root, "proof.txt"), externalInput);
        await expect(fs.realpath(externalInput)).resolves.toBe(path.join(root, "proof.txt"));
        await expect(assertSandboxPath({ filePath: cwd, cwd, root })).resolves.toEqual({
          resolved: path.join(root, "nested"),
          relative: "nested",
        });
        await expect(assertSandboxPath({ filePath: externalInput, cwd, root })).rejects.toThrow(
          /escapes sandbox root/i,
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves final-symlink unlink policy through a root alias",
    async () => {
      await withSandboxRoot(async (parent) => {
        const realRoot = path.join(parent, "real-workspace");
        const linkedRoot = path.join(parent, "linked-workspace");
        const outside = path.join(parent, "outside.txt");
        await fs.mkdir(realRoot);
        await fs.writeFile(outside, "outside", "utf8");
        await fs.symlink(realRoot, linkedRoot);
        await fs.symlink(outside, path.join(realRoot, "link"));

        await expect(sandboxPath(linkedRoot, "link", true)).resolves.toMatchObject({
          relative: "link",
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "checks raw absolute parents before a path enters the declared root",
    async () => {
      await withSandboxRoot(async (dir) => {
        const parent = await fs.realpath(dir);
        const root = path.join(parent, "workspace");
        const outside = path.join(parent, "outside", "workspace");
        await fs.mkdir(root);
        await fs.mkdir(outside, { recursive: true });
        await fs.mkdir(path.join(parent, "outside", "deep"));
        await fs.mkdir(path.join(parent, "plain"));
        await fs.symlink(path.join(parent, "outside", "deep"), path.join(parent, "jump"));
        await fs.writeFile(path.join(root, "proof.txt"), "inside");
        await fs.writeFile(path.join(outside, "proof.txt"), "outside");
        const escaped = `${parent}/jump/../workspace/proof.txt`;
        await expect(fs.readFile(escaped, "utf8")).resolves.toBe("outside");
        expect(path.resolve(escaped)).toBe(path.join(root, "proof.txt"));
        await expect(sandboxPath(root, escaped)).rejects.toMatchObject({
          code: "outside-workspace",
          category: "policy",
        });
        await expect(
          sandboxPath(root, `${parent}/plain/../workspace/proof.txt`),
        ).resolves.toMatchObject({ relative: "proof.txt" });
      });
    },
  );
});

describe("resolveSandboxedMediaSource", () => {
  const openClawTmpDir = resolvePreferredOpenClawTmpDir();

  it("allows file:// URLs pointing to preferred OpenClaw tmp root", async () => {
    const file = path.join(openClawTmpDir, "photo.png");
    await expectMediaPath(pathToFileURL(file).href, () => path.resolve(file));
  });

  it("allows managed file-transfer tool media outside the sandbox root", async () => {
    await withManagedMediaRoot(async ({ stateDir }) => {
      const media = path.join(stateDir, "media", "tool-file-transfer", "fetched.png");
      await fs.writeFile(media, "image", "utf8");
      await expectMediaPath(media, () => media);
    });
  });

  it("does not allow unrelated state media directories as managed media", async () => {
    await withManagedMediaRoot(async ({ stateDir }) => {
      const media = path.join(stateDir, "media", "inbound", "reply.png");
      await fs.mkdir(path.dirname(media), { recursive: true });
      await fs.writeFile(media, "image", "utf8");

      await expect(resolveAllowedManagedMediaPath(media)).resolves.toBeUndefined();
    });
  });

  it("resolves sandbox-relative paths", async () => {
    await expectMediaPath("./data/file.txt", (root) => path.join(root, "data", "file.txt"));
  });

  it("maps container /workspace absolute paths into sandbox root", async () => {
    await expectMediaPath("/workspace/media/pic.png", (root) =>
      path.join(root, "media", "pic.png"),
    );
  });

  it("maps FILE: URLs under /workspace into sandbox root", async () => {
    await expectMediaPath("FILE:/workspace/media/pic.png", (root) =>
      path.join(root, "media", "pic.png"),
    );
  });

  it("rejects paths outside the authoritative backend workdir", async () => {
    await withSandboxRoot(async (sandboxRoot) => {
      await expect(
        resolveSandboxedMediaSource({
          media: "/sandbox-other/secret.png",
          sandboxRoot,
          containerWorkdir: "/sandbox",
        }),
      ).rejects.toThrow(/sandbox/i);
    });
  });

  it("preserves remote mxc:// media sources", async () => {
    await expectMediaPath("mxc://matrix.org/abc123def456", () => "mxc://matrix.org/abc123def456");
  });

  it.each<[string, RegExp]>([
    ["/etc/passwd", /sandbox/i],
    ["../outside-sandbox.png", /sandbox/i],
    ["file://attacker/workspace/photo.png", /remote hosts are not allowed/i],
    ["file://not a valid url\x00", /Invalid file:\/\/ URL/],
    ["file:///workspace/%E0%A4%A", /Invalid file:\/\/ URL/],
    ["file:///workspace/%2FREADME.md", /cannot encode path separators/i],
  ])("rejects %s", async (media, expected) => {
    await withSandboxRoot(async (sandboxDir) => {
      await expectSandboxRejection(media, sandboxDir, expected);
    });
  });

  it("rejects symlinked OpenClaw tmp paths escaping tmp root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const outsideTmpTarget = path.resolve(process.cwd(), "package.json");
    if (isPathInside(openClawTmpDir, outsideTmpTarget)) {
      return;
    }

    await withSandboxRoot(async (sandboxDir) => {
      await fs.access(outsideTmpTarget);
      await fs.mkdir(openClawTmpDir, { recursive: true });
      const symlinkPath = path.join(openClawTmpDir, `tmp-link-escape-${process.pid}`);
      await fs.symlink(outsideTmpTarget, symlinkPath);
      try {
        await expectSandboxRejection(symlinkPath, sandboxDir, /symlink|sandbox/i);
      } finally {
        await fs.unlink(symlinkPath).catch(() => {});
      }
    });
  });

  it("rejects sandbox symlink escapes when the outside leaf does not exist yet", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSandboxRoot(async (sandboxDir) => {
      await withSandboxRoot(async (outsideDir) => {
        const linkDir = path.join(sandboxDir, "escape-link");
        await fs.symlink(outsideDir, linkDir);
        const missingOutsidePath = path.join(linkDir, "new-file.txt");
        await expectSandboxRejection(missingOutsidePath, sandboxDir, /symlink|sandbox/i);
      }, process.cwd());
    });
  });

  it("rejects hardlinked OpenClaw tmp paths to outside files", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOutsideHardlinkInOpenClawTmp(openClawTmpDir, async (hardlinkPath) => {
      await withSandboxRoot(async (sandboxDir) => {
        await expectSandboxRejection(hardlinkPath, sandboxDir, /hard.?link|sandbox/i);
      });
    });
  });

  it("rejects symlinked managed media paths escaping the outbound root", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withManagedMediaRoot(async ({ stateDir }) => {
      await withSandboxRoot(async (sandboxDir) => {
        await withSandboxRoot(async (outsideDir) => {
          const outsideFile = path.join(outsideDir, "secret.png");
          const symlinkPath = path.join(stateDir, "media", "outbound", "linked-secret.png");
          await fs.writeFile(outsideFile, "secret", "utf8");
          await fs.symlink(outsideFile, symlinkPath);

          await expectSandboxRejection(symlinkPath, sandboxDir, /managed media root|symlink/i);
        });
      });
    });
  });

  it("rejects hardlinked file-transfer media that aliases a file outside managed media", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withManagedMediaRoot(async ({ stateDir }) => {
      await withSandboxRoot(async (sandboxDir) => {
        await withSandboxRoot(async (outsideDir) => {
          const outsideFile = path.join(outsideDir, "secret.png");
          const hardlinkPath = path.join(
            stateDir,
            "media",
            "tool-file-transfer",
            "linked-secret.png",
          );
          await fs.writeFile(outsideFile, "secret", "utf8");
          try {
            await fs.link(outsideFile, hardlinkPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EXDEV") {
              return;
            }
            throw err;
          }

          await expect(resolveAllowedManagedMediaPath(hardlinkPath)).rejects.toThrow(/hard.?link/i);
          await expectSandboxRejection(hardlinkPath, sandboxDir, /hard.?link|managed media root/i);
        }, path.dirname(stateDir));
      });
    });
  });

  it("returns empty string for whitespace-only input", async () => {
    await expect(
      resolveSandboxedMediaSource({ media: "   ", sandboxRoot: "/any/path" }),
    ).resolves.toBe("");
  });

  it("rejects Windows network paths before sandbox resolution", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expect(
        resolveSandboxedMediaSource({
          media: "\\\\attacker\\share\\photo.png",
          sandboxRoot: "/any/path",
        }),
      ).rejects.toThrow(/network paths/i);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
