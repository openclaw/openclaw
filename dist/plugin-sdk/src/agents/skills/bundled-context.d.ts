import { type BundledSkillsResolveOptions } from "./bundled-dir.js";
export type BundledSkillsContext = {
    dir?: string;
    names: Set<string>;
};
export declare function resolveBundledSkillsContext(opts?: BundledSkillsResolveOptions): BundledSkillsContext;
