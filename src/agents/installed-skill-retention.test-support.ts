import assert from "node:assert/strict";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { createSyntheticSourceInfo } from "../skills/loading/skill-contract.js";
import { searchInstalledSkills, type InstalledSkill } from "./installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";

assert(global.gc, "Run with --expose-gc");
const publications = Array.from({ length: 96 }, (_, index) => ({
  name: `guide-${index}`,
  description: `Guide ${index}. ${"Search quasar records and read files. ".repeat(24)}`,
  filePath: `node://synthetic/guide-${index}/SKILL.md`,
  baseDir: "node://synthetic",
  source: "synthetic",
  sourceInfo: createSyntheticSourceInfo(`node://synthetic/guide-${index}/SKILL.md`, {
    source: "synthetic",
  }),
  contentHash: `synthetic-${index}`,
  disableModelInvocation: false,
}));
async function heap() {
  await yieldTurn();
  global.gc!();
  await yieldTurn();
  global.gc!();
  return process.memoryUsage().heapUsed;
}
const before = await heap();
const catalogs: InstalledSkill[][] = [];
for (let attempt = 0; attempt < 100; attempt++) {
  const selected = publications.slice(attempt % 6);
  const catalog = prepareInstalledSkillCatalog({
    snapshot: {
      prompt: "",
      skills: selected.map(({ name }) => ({ name })),
      discoverySkills: selected,
    },
    workspaceDir: "/synthetic",
  });
  assert.equal((await searchInstalledSkills(catalog, "quasar")).skills.length, 5);
  catalogs.push(catalog);
}
const retained = (await heap()) - before;
assert.equal(catalogs.length, 100);
assert(
  retained < 8 * 1024 * 1024,
  `Live catalog metadata retained ${retained} bytes (budget 8 MiB)`,
);
