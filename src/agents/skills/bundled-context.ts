import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import { resolveBundledSkillsDir, type BundledSkillsResolveOptions } from "./bundled-dir.js";

export type BundledSkillsContext = {
  dir?: string;
  names: Set<string>;
};

export function resolveBundledSkillsContext(
  opts: BundledSkillsResolveOptions = {},
): BundledSkillsContext {
  const dir = resolveBundledSkillsDir(opts);
  const names = new Set<string>();
  if (!dir) {
    return { dir, names };
  }
  const result = loadSkillsFromDir({ dir, source: "openclaw-bundled" });
  for (const skill of result.skills) {
    if (skill.name.trim()) {
      names.add(skill.name);
    }
  }
  return { dir, names };
}
