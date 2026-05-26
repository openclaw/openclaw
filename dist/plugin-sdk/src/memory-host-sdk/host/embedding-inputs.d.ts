export type EmbeddingInputTextPart = {
    type: "text";
    text: string;
};
export type EmbeddingInputInlineDataPart = {
    type: "inline-data";
    mimeType: string;
    data: string;
};
export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;
export type EmbeddingInput = {
    text: string;
    parts?: EmbeddingInputPart[];
};
export declare function buildTextEmbeddingInput(text: string): EmbeddingInput;
export declare function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean;
