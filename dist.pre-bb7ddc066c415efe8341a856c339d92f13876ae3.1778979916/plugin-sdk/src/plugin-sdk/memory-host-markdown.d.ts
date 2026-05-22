export type ManagedMarkdownBlockParams = {
    original: string;
    body: string;
    startMarker: string;
    endMarker: string;
    heading?: string;
};
export declare function withTrailingNewline(content: string): string;
export declare function replaceManagedMarkdownBlock(params: ManagedMarkdownBlockParams): string;
