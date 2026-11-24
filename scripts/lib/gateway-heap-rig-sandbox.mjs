import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Synthetic files only; preparation finishes before the Gateway is launched. */
export async function prepareHeapRigSandboxWorkspaces(config, large, worktrees) {
  const skills = Array.from({ length: 135 }, (_, index) => `synthetic-sandbox-${index}`);
  config.agents.defaults.skills = skills;
  let files = 0;
  let bytes = 0;
  const commits = {};
  const put = async (file, content) => {
    await writeFile(file, content);
    files++;
    bytes += Buffer.byteLength(content);
  };
  for (const [agentId, { workspace }] of Object.entries(config.agents.entries)) {
    for (const name of skills) {
      const directory = path.join(workspace, "skills", name);
      await mkdir(directory, { recursive: true });
      await put(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Synthetic sandbox retention fixture\n---\nSynthetic instructions.\n`,
      );
      for (let index = 0; index < 8; index++) {
        await put(path.join(directory, `reference-${index}.txt`), "x".repeat(4096));
      }
    }
    if (large) {
      const directory = path.join(workspace, "synthetic-background");
      await mkdir(directory);
      for (let index = 0; index < 31_000; index++) {
        await put(path.join(directory, `${index}.txt`), "x".repeat(18_000));
      }
    }
    if (worktrees) {
      const git = (args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
      git(["add", "--all"]);
      git([
        "-c",
        "user.name=Synthetic retention fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "Synthetic sandbox retention fixture",
      ]);
      commits[agentId] = git(["rev-parse", "HEAD"]).trim();
    }
  }
  return {
    files,
    bytes,
    commits,
    skillsPerWorkspace: skills.length,
    backgroundFiles: large ? 62_000 : 0,
  };
}
