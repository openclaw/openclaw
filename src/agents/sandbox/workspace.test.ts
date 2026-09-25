// Sandbox workspace tests cover bootstrap file seeding into isolated workspaces
// without following unsafe host links.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { injectPartialPublicationFailure } from "../workspace-bootstrap-publish.test-support.js";
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
    const injection = await injectPartialPublicationFailure(sandbox, DEFAULT_AGENTS_FILENAME);

    try {
      await expect(ensureSandboxWorkspace(sandbox, seed, true)).rejects.toMatchObject({
        code: "ENOSPC",
      });
      injection.assertInjected();
      await expect(fs.readFile(agentsPath, "utf-8")).rejects.toThrow("no such file");
      expect(
        (await fs.readdir(sandbox)).filter((name) => name.startsWith("openclaw-bootstrap-")),
      ).toEqual([]);
    } finally {
      injection.restore();
    }

    await ensureSandboxWorkspace(sandbox, seed, true);
    await expect(fs.readFile(agentsPath, "utf-8")).resolves.toBe("seeded-agents");
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin").each([false, true])(
    "uses native no-replace publication without overwriting a racing winner (%s)",
    async (racingWinner) => {
      const root = tempDirs.make("openclaw-sandbox-workspace-");
      const seed = path.join(root, "seed");
      const sandbox = path.join(root, "sandbox");
      await fs.mkdir(seed, { recursive: true });
      await fs.mkdir(sandbox, { recursive: true });
      const agentsPath = path.join(await fs.realpath(sandbox), DEFAULT_AGENTS_FILENAME);
      await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf8");
      const nativeConfig = getFsSafeNativeConfig();
      const realLink = syncFs.linkSync.bind(syncFs);
      const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
        if (String(target) !== agentsPath) {
          return realLink(source, target);
        }
        if (racingWinner) {
          syncFs.writeFileSync(agentsPath, "WINNER", { flag: "wx" });
        }
        throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
      });
      try {
        configureFsSafeNative({ mode: "require" });
        await ensureSandboxWorkspace(sandbox, seed, true);
        expect(linkSpy).toHaveBeenCalledWith(expect.anything(), agentsPath);
        expect(await fs.readFile(agentsPath, "utf8")).toBe(
          racingWinner ? "WINNER" : "seeded-agents",
        );
        expect((await fs.lstat(agentsPath)).nlink).toBe(1);
        expect(await fs.readdir(sandbox)).toEqual([DEFAULT_AGENTS_FILENAME]);
      } finally {
        linkSpy.mockRestore();
        configureFsSafeNative(nativeConfig);
      }
    },
  );

  it("fails closed when sandbox seed publication has neither hardlinks nor native no-replace", async () => {
    const root = tempDirs.make("openclaw-sandbox-workspace-");
    const seed = path.join(root, "seed");
    const sandbox = path.join(root, "sandbox");
    const agentsPath = path.join(sandbox, DEFAULT_AGENTS_FILENAME);
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, DEFAULT_AGENTS_FILENAME), "seeded-agents", "utf-8");
    await fs.mkdir(sandbox, { recursive: true });
    const finalPath = path.join(await fs.realpath(sandbox), DEFAULT_AGENTS_FILENAME);
    const nativeConfig = getFsSafeNativeConfig();
    const realLink = syncFs.linkSync.bind(syncFs);
    const linkSpy = vi.spyOn(syncFs, "linkSync").mockImplementation((source, target) => {
      if (String(target) === finalPath) {
        throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
      }
      return realLink(source, target);
    });

    try {
      configureFsSafeNative({ mode: "off" });
      await expect(ensureSandboxWorkspace(sandbox, seed, true)).rejects.toMatchObject({
        code: "helper-unavailable",
      });
      await expect(fs.readFile(agentsPath, "utf8")).rejects.toThrow("no such file");
      expect(await fs.readdir(sandbox)).toEqual([]);
    } finally {
      linkSpy.mockRestore();
      configureFsSafeNative(nativeConfig);
    }
  });
});
