// Sandbox workspace tests cover bootstrap file seeding into isolated workspaces
// without following unsafe host links.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME } from "../workspace.js";
import { ensureSandboxWorkspace } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("ensureSandboxWorkspace", () => {
  it("seeds regular bootstrap files from the source workspace", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf-8");

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).resolves.toBe(
      "seeded-agents",
    );
  });

  it.runIf(process.platform !== "win32")("skips symlinked bootstrap seed files", async () => {
    // Bootstrap files can influence agent behavior; symlinks must not pull in
    // arbitrary host files from outside the source workspace.
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const outside = path.join(root, "outside-secret.txt");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(outside, "secret", "utf-8");
    await fs.symlink(outside, path.join(seed, DEFAULT_AGENTS_FILENAME));

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).rejects.toThrow(
      "no such file",
    );
  });

  it.runIf(process.platform !== "win32")("skips hardlinked bootstrap seed files", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const outside = path.join(root, "outside-agents.txt");
    const linkedSeed = path.join(seed, DEFAULT_AGENTS_FILENAME);
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(outside, "outside", "utf-8");
    try {
      await fs.link(outside, linkedSeed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).rejects.toThrow(
      "no such file",
    );
  });

  it("skips an oversized seed file but still seeds the others", async () => {
    // An unbounded read would copy the oversized file through; the bound skips it.
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(
      path.join(seed, DEFAULT_AGENTS_FILENAME),
      `## Startup\n\n` + "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES),
      "utf-8",
    );
    await fs.writeFile(path.join(seed, DEFAULT_SOUL_FILENAME), "seeded-soul", "utf-8");

    await ensureSandboxWorkspace(sandbox, seed, true);

    await expect(fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8")).rejects.toThrow(
      "no such file",
    );
    await expect(fs.readFile(path.join(sandbox, DEFAULT_SOUL_FILENAME), "utf-8")).resolves.toBe(
      "seeded-soul",
    );
  });

  it("seeds a bootstrap file at the byte read limit", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    await fs.mkdir(seed, { recursive: true });
    const content = "## Startup\n\nDo startup things.\n";
    const padding = "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - content.length);
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), content + padding, "utf-8");

    await ensureSandboxWorkspace(sandbox, seed, true);

    const seeded = await fs.readFile(path.join(sandbox, DEFAULT_AGENTS_FILENAME), "utf-8");
    expect(seeded).toContain("Do startup things");
  });

  it("does not publish a partial sandbox seed when the first write fails", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const agentsPath = path.join(sandbox, DEFAULT_AGENTS_FILENAME);
    await fs.mkdir(seed, { recursive: true });
    await fs.mkdir(sandbox, { recursive: true });
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf-8");
    const resolvedSandbox = await fs.realpath(sandbox);
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const rawPath = nodeFilePath(args[0]);
      const exclusiveCreate =
        typeof args[1] === "number" &&
        (args[1] & syncFs.constants.O_CREAT) !== 0 &&
        (args[1] & syncFs.constants.O_EXCL) !== 0;
      if (
        !injected &&
        rawPath &&
        path.dirname(path.resolve(rawPath)) === resolvedSandbox &&
        exclusiveCreate
      ) {
        vi.spyOn(handle, "write").mockImplementationOnce(async () => {
          injected = true;
          await handle.writeFile("# PARTIAL\n");
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        });
      }
      return handle;
    });

    try {
      await expect(
        withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
          ensureSandboxWorkspace(sandbox, seed, true),
        ),
      ).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
      expect(injected).toBe(true);
      await expect(fs.readFile(agentsPath, "utf-8")).rejects.toThrow("no such file");
      expect(await fs.readdir(sandbox)).toEqual([]);
    } finally {
      spy.mockRestore();
    }

    await ensureSandboxWorkspace(sandbox, seed, true);
    await expect(fs.readFile(agentsPath, "utf-8")).resolves.toBe("seeded-agents");
  });

  it("reports when sandbox seed publication cannot use hard links", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const agentsPath = path.join(sandbox, DEFAULT_AGENTS_FILENAME);
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf-8");
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });

    try {
      await expect(
        withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
          ensureSandboxWorkspace(sandbox, seed, true),
        ),
      ).rejects.toThrow(/filesystem does not support atomic bootstrap publication/u);
      await expect(fs.readFile(agentsPath, "utf8")).rejects.toThrow("no such file");
      expect(await fs.readdir(sandbox)).toEqual([]);
    } finally {
      linkSpy.mockRestore();
    }
  });
});
