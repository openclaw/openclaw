import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBundledSkillsDir, type BundledSkillsResolveOptions } from "./bundled-dir.js";

const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;

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
    if (!hasWarnedMissingBundledDir) {
      hasWarnedMissingBundledDir = true;
      skillsLogger.warn(
        "Bundled skills directory could not be resolved; built-in skills may be missing.",
      );
    }
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
