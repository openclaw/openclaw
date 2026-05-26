export declare function writeSkill(params: {
    dir: string;
    name: string;
    description: string;
    metadata?: string;
    body?: string;
    frontmatterExtra?: string;
}): Promise<void>;
export declare function writeWorkspaceSkills(workspaceDir: string, skills: ReadonlyArray<{
    name: string;
    description: string;
    metadata?: string;
    body?: string;
    frontmatterExtra?: string;
}>): Promise<void>;
