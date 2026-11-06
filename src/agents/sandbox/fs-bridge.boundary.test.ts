import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  createHostEscapeFixture,
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  expectMkdirpAllowsExistingDirectory,
  getScriptsFromCalls,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

const bridgeFor = (workspaceDir: string) =>
  createSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
  });

installFsBridgeTestHarness();

it("allows mkdirp when boundary open reports io for an existing directory", async () => {
  await expectMkdirpAllowsExistingDirectory({ forceBoundaryIoFallback: true });
});

it.each(["file", "directory", "hardlink"] as const)(
  "rejects pre-existing host %s escapes before content access",
  async (kind) => {
    await withTempDir("openclaw-fs-bridge-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      if (process.platform === "win32") {
        return;
      }
      try {
        await (kind === "hardlink" ? fs.link : fs.symlink)(
          kind === "directory" ? path.dirname(outsideFile) : outsideFile,
          path.join(workspaceDir, "link.txt"),
        );
      } catch (err) {
        if (kind === "hardlink" && (err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const bridge = bridgeFor(workspaceDir);
      await expect(
        kind === "directory"
          ? bridge.mkdirp({ filePath: "link.txt" })
          : bridge.readFile({ filePath: "link.txt" }),
      ).rejects.toThrow(kind === "hardlink" ? /hardlink|sandbox/i : /Symlink escapes/);
      if (kind === "directory") {
        expect(mockedExecDockerRaw).not.toHaveBeenCalled();
      } else {
        expectOnlyCanonicalPathCommands();
      }
    });
  },
);

it.runIf(process.platform !== "win32")("rejects FIFO swaps at descriptor open", async () => {
  await withTempDir("openclaw-fs-bridge-fifo-swap-", async (stateDir) => {
    const workspaceDir = path.join(stateDir, "workspace");
    const filePath = path.join(workspaceDir, "live.pipe");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(filePath, "regular");
    const bridge = bridgeFor(workspaceDir);
    const realOpenSync = fsSync.openSync.bind(fsSync);
    using openSync = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
      if (path.resolve(String(target)) === filePath) {
        if (typeof flags !== "number" || (flags & fsSync.constants.O_NONBLOCK) === 0) {
          throw new Error("sandbox read descriptor open is blocking");
        }
        fsSync.unlinkSync(filePath);
        expect(spawnSync("mkfifo", [filePath]).status).toBe(0);
      }
      return realOpenSync(target, flags, mode);
    });

    void openSync;
    await expect(bridge.readFile({ filePath: "live.pipe" })).rejects.toThrow(
      /boundary checks|cannot read/i,
    );
    expectOnlyCanonicalPathCommands();
  });
});

it("re-validates target before the pinned write helper runs", async () => {
  mockedOpenRootFile
    .mockImplementationOnce(async () => ({ ok: false, reason: "path" }))
    .mockImplementationOnce(async () => ({
      ok: false,
      reason: "validation",
      error: new Error("Hardlinked path is not allowed"),
    }));

  const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
  await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
    /hardlinked path/i,
  );

  expect(getScriptsFromCalls().join("\n")).not.toContain("os.replace(");
});
