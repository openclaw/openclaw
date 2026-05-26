export declare function updateSkillConfigEntry(params: {
    skillKey: string;
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
}): Promise<Record<string, unknown>>;
