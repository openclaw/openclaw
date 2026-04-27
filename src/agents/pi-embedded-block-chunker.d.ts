export type BlockReplyChunking = {
    minChars: number;
    maxChars: number;
    breakPreference?: "paragraph" | "newline" | "sentence";
    /** When true, prefer \n\n paragraph boundaries once minChars has been satisfied. */
    flushOnParagraph?: boolean;
};
export declare class EmbeddedBlockChunker {
    #private;
    constructor(chunking: BlockReplyChunking);
    append(text: string): void;
    reset(): void;
    get bufferedText(): string;
    hasBuffered(): boolean;
    drain(params: {
        force: boolean;
        emit: (chunk: string) => void;
    }): void;
}
