import fs from "node:fs/promises";
import path from "node:path";
import { createSyntheticSourceInfo, type Skill } from "@mariozechner/pi-coding-agent";

export async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  body?: string;
}) {
  const { dir, name, description, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

export function createCanonicalFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): Skill {
  // Keep skill fixtures on the upstream canonical provenance shape.
  return {
    name: params.name,
    description: params.description,
    filePath: params.filePath,
    baseDir: params.baseDir,
    source: params.source,
    sourceInfo: createSyntheticSourceInfo(params.filePath, {
      source: params.source,
      baseDir: params.baseDir,
    }),
    disableModelInvocation: params.disableModelInvocation ?? false,
  };
}
