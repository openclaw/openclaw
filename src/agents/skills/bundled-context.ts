import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBundledSkillsDir, type BundledSkillsResolveOptions } from "./bundled-dir.js";
import { resolveOpenClawMetadata, resolveSkillKey } from "./frontmatter.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;
let cachedBundledContext: { dir: string; names: Set<string>; skillKeys: Set<string> } | null = null;

export type BundledSkillsContext = {
  dir?: string;
  names: Set<string>;
  skillKeys: Set<string>;
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
    return { dir, names, skillKeys: new Set() };
  }

  if (cachedBundledContext?.dir === dir) {
    return {
      dir,
      names: new Set(cachedBundledContext.names),
      skillKeys: new Set(cachedBundledContext.skillKeys),
    };
  }
  const result = loadSkillsFromDirSafe({ dir, source: "openclaw-bundled" });
  const skillKeys = new Set<string>();
  for (const skill of result.skills) {
    if (skill.name.trim()) {
      names.add(skill.name);
    }
    const frontmatter = result.frontmatterByFilePath.get(skill.filePath) ?? {};
    const metadata = resolveOpenClawMetadata(frontmatter);
    const skillKey = resolveSkillKey(skill, { skill, frontmatter, metadata });
    if (skillKey.trim()) {
      skillKeys.add(skillKey);
    }
  }
  cachedBundledContext = { dir, names: new Set(names), skillKeys: new Set(skillKeys) };
  return { dir, names, skillKeys };
}
