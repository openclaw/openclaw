import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createMirrorFsBridgeFixture,
  createOpenShellTestWorkspace,
} from "./openshell-fs.test-support.js";

it("keeps omitted read limits unlimited and explicit zero limits empty", async () => {
  await using workspace = await createOpenShellTestWorkspace("read-limit");
  const { bridge } = await createMirrorFsBridgeFixture(workspace.dir);
  // Omitting the caller limit must not inherit fs-safe's default 16 MiB cap.
  const large = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
  await fs.writeFile(path.join(workspace.dir, "large.bin"), large);
  expect((await bridge.readFile({ filePath: "large.bin" })).equals(large)).toBe(true);
  await expect(bridge.readFile({ filePath: "large.bin", maxBytes: 0 })).rejects.toThrow(
    "Sandbox boundary checks failed",
  );
  await fs.writeFile(path.join(workspace.dir, "empty.bin"), "");
  await expect(bridge.readFile({ filePath: "empty.bin", maxBytes: 0 })).resolves.toEqual(
    Buffer.alloc(0),
  );
});

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "rejects inaccessible local mirror parents before remote mutations",
  async () => {
    await using workspace = await createOpenShellTestWorkspace("preflight");
    const lockedDir = path.join(workspace.dir, "locked");
    await fs.mkdir(lockedDir);
    const { backend, bridge } = await createMirrorFsBridgeFixture(workspace.dir);
    await fs.chmod(lockedDir, 0o000);
    try {
      await expect(bridge.mkdirp({ filePath: "locked/nested" })).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(backend.mkdirpRemotePath).not.toHaveBeenCalled();
      await expect(
        bridge.remove({ filePath: "locked/file.txt", force: true }),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(backend.removeRemotePath).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(lockedDir, 0o700);
    }
  },
);
