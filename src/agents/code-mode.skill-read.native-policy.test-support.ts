import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { readInstalledSkill } from "./installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";

const directory = process.argv[2]!;
const filePath = path.join(directory, "SKILL.md");
await fs.writeFile(filePath, "Synthetic instructions");
await fs.writeFile(path.join(directory, "companion.md"), "Synthetic companion");
const skill = createCanonicalFixtureSkill({
  name: "guide",
  description: "Synthetic guide",
  filePath,
  baseDir: directory,
  source: "bundled",
});
try {
  const snapshot = await buildSkillSnapshot(directory, { entries: [{ skill, frontmatter: {} }] });
  const catalog = prepareInstalledSkillCatalog({ snapshot, workspaceDir: directory });
  for (const mode of ["require", "off", "require"] as const) {
    configureFsSafeNative({ mode });
    const result = await readInstalledSkill(catalog, "guide", undefined, "companion.md").then(
      (read) => read.content,
      () => undefined,
    );
    assert.equal(result, mode === "require" ? undefined : "Synthetic companion", `native ${mode}`);
    assert.equal(getFsSafeNativeConfig().mode, mode);
  }
} finally {
  await closeSkillsWatchers();
}
