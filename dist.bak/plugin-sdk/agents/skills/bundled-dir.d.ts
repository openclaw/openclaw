export type BundledSkillsResolveOptions = {
    argv1?: string;
    moduleUrl?: string;
    cwd?: string;
    execPath?: string;
};
export declare function resolveBundledSkillsDir(opts?: BundledSkillsResolveOptions): string | undefined;
