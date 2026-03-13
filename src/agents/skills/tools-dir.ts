import path from "node:path";
import type { SkillEntry } from "./types.js";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveConfigDir } from "../../utils.js";
import { resolveSkillKey } from "./frontmatter.js";

export function resolveSkillToolsRootDir(entry: SkillEntry): string {
  const key = resolveSkillKey(entry.skill, entry);
  const safeKey = safePathSegmentHashed(key);
  return path.join(resolveConfigDir(), "tools", safeKey);
}
