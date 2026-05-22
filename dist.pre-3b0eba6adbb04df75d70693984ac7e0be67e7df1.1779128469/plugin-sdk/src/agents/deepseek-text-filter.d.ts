export interface DeepSeekTextFilter {
    push(chunk: string): string[];
    flush(): string[];
}
export declare function createDeepSeekTextFilter(): DeepSeekTextFilter;
