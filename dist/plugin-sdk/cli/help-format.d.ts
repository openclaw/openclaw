export type HelpExample = readonly [command: string, description: string];
export declare function formatHelpExample(command: string, description: string): string;
export declare function formatHelpExampleLine(command: string, description: string): string;
export declare function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline?: boolean): string;
export declare function formatHelpExampleGroup(label: string, examples: ReadonlyArray<HelpExample>, inline?: boolean): string;
