import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolvePluginSkillDirs(params: {
    workspaceDir: string | undefined;
    config?: OpenClawConfig;
    /** Override the plugin skills directory for testing. */
    pluginSkillsDir?: string;
}): string[];
/**
 * Creates symlinks from each resolved plugin skill directory into the
 * plugin skills directory (~/.openclaw/plugin-skills/) so the agent SDK can
 * discover them at the conventional file-system path.
 *
 * The plugin-skills directory is fully owned by OpenClaw — every entry is
 * a generated symlink. Cleanup of stale links is therefore safe.
 */
declare function publishPluginSkills(skillDirs: string[], opts?: {
    pluginSkillsDir?: string;
}): void;
export declare const __testing: {
    publishPluginSkills: typeof publishPluginSkills;
};
export {};
