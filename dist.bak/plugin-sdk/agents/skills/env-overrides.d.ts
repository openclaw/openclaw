import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";
export declare function applySkillEnvOverrides(params: {
    skills: SkillEntry[];
    config?: OpenClawConfig;
}): () => void;
export declare function applySkillEnvOverridesFromSnapshot(params: {
    snapshot?: SkillSnapshot;
    config?: OpenClawConfig;
}): () => void;
