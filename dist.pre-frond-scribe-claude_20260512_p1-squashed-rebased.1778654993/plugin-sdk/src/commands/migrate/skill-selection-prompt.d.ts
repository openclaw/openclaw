type MigrationSkillSelectionOption = {
    value: string;
    label?: string;
    hint?: string;
    disabled?: boolean;
};
export type MigrationSkillSelectionPromptOptions = {
    message: string;
    options: MigrationSkillSelectionOption[];
    initialValues?: string[];
    maxItems?: number;
    required?: boolean;
    cursorAt?: string;
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
    signal?: AbortSignal;
    withGuide?: boolean;
    selectableValues: readonly string[];
};
export declare function promptMigrationSkillSelectionValues(opts: MigrationSkillSelectionPromptOptions): Promise<string[] | symbol | undefined>;
export declare const promptMigrationSelectionValues: typeof promptMigrationSkillSelectionValues;
export {};
