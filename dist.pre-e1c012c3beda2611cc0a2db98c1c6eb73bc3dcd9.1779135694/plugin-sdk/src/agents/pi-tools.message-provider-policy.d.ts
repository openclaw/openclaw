export declare function filterToolNamesByMessageProvider(toolNames: readonly string[], messageProvider?: string): string[];
export declare function filterToolsByMessageProvider<TTool extends {
    name: string;
}>(tools: readonly TTool[], messageProvider?: string): TTool[];
