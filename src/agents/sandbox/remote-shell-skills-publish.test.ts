// Direct execution tests for the remote skills-tree rotation script shipped to
// SSH sandbox backends. These run the exact published python source locally
// against temp dirs to prove rotation semantics and syntax.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { REPLACE_REMOTE_SKILLS_WORKSPACE } from "./remote-shell-bootstrap-python.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runPublish(staging: string, destination: string, backup: string): Promise<void> {
  await execFileAsync("python3", [
    "-c",
    REPLACE_REMOTE_SKILLS_WORKSPACE,
    staging,
    destination,
    backup,
  ]);
}

describe("REPLACE_REMOTE_SKILLS_WORKSPACE", () => {
  it("rotates the live tree aside and publishes the staged tree", async () => {
    const root = tempDirs.make("skills-rotate-");
    const parent = path.join(root, ".openclaw");
    await fs.mkdir(parent, { recursive: true });
    const destination = path.join(parent, "sandbox-skills");
    const staging = `${destination}.stage-1`;
    const backup = `${destination}.old-1`;
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "old.txt"), "old");
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "new.txt"), "new");

    await runPublish(staging, destination, backup);

    expect(await fs.readFile(path.join(destination, "new.txt"), "utf8")).toBe("new");
    await expect(fs.stat(path.join(destination, "old.txt"))).rejects.toThrow();
    await expect(fs.stat(staging)).rejects.toThrow();
    await expect(fs.stat(backup)).rejects.toThrow();
  });

  it("publishes when no previous skills tree exists", async () => {
    const root = tempDirs.make("skills-rotate-empty-");
    const parent = path.join(root, ".openclaw");
    await fs.mkdir(parent, { recursive: true });
    const destination = path.join(parent, "sandbox-skills");
    const staging = `${destination}.stage-1`;
    const backup = `${destination}.old-1`;
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "new.txt"), "new");

    await runPublish(staging, destination, backup);

    expect(await fs.readFile(path.join(destination, "new.txt"), "utf8")).toBe("new");
    await expect(fs.stat(staging)).rejects.toThrow();
  });

  it("refuses staging outside the destination parent", async () => {
    const root = tempDirs.make("skills-rotate-escape-");
    const parent = path.join(root, ".openclaw");
    await fs.mkdir(parent, { recursive: true });
    const destination = path.join(parent, "sandbox-skills");
    const staging = path.join(root, "elsewhere");
    await fs.mkdir(staging, { recursive: true });

    await expect(runPublish(staging, destination, path.join(parent, "backup"))).rejects.toThrow();
  });

  it("fails without touching the live tree when staging is missing", async () => {
    const root = tempDirs.make("skills-rotate-missing-");
    const parent = path.join(root, ".openclaw");
    await fs.mkdir(parent, { recursive: true });
    const destination = path.join(parent, "sandbox-skills");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "old.txt"), "old");

    await expect(
      runPublish(path.join(parent, "nope"), destination, path.join(parent, "backup")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, "old.txt"), "utf8")).toBe("old");
  });
});
