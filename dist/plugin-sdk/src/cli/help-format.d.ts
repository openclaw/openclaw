export type HelpExample = readonly [command: string, description: string];
export declare function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline?: boolean): string;
