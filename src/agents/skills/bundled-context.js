import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";
const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;
let cachedBundledContext = null;
export function resolveBundledSkillsContext(opts = {}) {
    const dir = resolveBundledSkillsDir(opts);
    const names = new Set();
    if (!dir) {
        if (!hasWarnedMissingBundledDir) {
            hasWarnedMissingBundledDir = true;
            skillsLogger.warn("Bundled skills directory could not be resolved; built-in skills may be missing.");
        }
        return { dir, names };
    }
    if (cachedBundledContext?.dir === dir) {
        return { dir, names: new Set(cachedBundledContext.names) };
    }
    const result = loadSkillsFromDirSafe({ dir, source: "openclaw-bundled" });
    for (const skill of result.skills) {
        if (skill.name.trim()) {
            names.add(skill.name);
        }
    }
    cachedBundledContext = { dir, names: new Set(names) };
    return { dir, names };
}
