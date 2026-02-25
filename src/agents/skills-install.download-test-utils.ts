import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "../test-utils/env.js";

export function setTempStateDir(workspaceDir: string): string {
  const stateDir = path.join(workspaceDir, "state");
  process.env.ACTIVI_STATE_DIR = stateDir;
  return stateDir;
}

export async function withTempWorkspace(
  run: (params: { workspaceDir: string; stateDir: string }) => Promise<void>,
) {
  const envSnapshot = captureEnv(["ACTIVI_STATE_DIR"]);
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "activi-skills-install-"));
  try {
    const stateDir = setTempStateDir(workspaceDir);
    await run({ workspaceDir, stateDir });
  } finally {
    envSnapshot.restore();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeDownloadSkill(params: {
  workspaceDir: string;
  name: string;
  installId: string;
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  stripComponents?: number;
  targetDir: string;
}): Promise<string> {
  const skillDir = path.join(params.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const meta = {
    activi: {
      install: [
        {
          id: params.installId,
          kind: "download",
          url: params.url,
          archive: params.archive,
          extract: true,
          stripComponents: params.stripComponents,
          targetDir: params.targetDir,
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${params.name}
description: test skill
metadata: ${JSON.stringify(meta)}
---

# ${params.name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}
