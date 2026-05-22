export type FinalTagMatch = {
    index: number;
    text: string;
    isClose: boolean;
    isSelfClosing: boolean;
};
export declare function parseFinalTag(text: string): Omit<FinalTagMatch, "index" | "text"> | null;
export declare function findFinalTagMatches(text: string): FinalTagMatch[];
export declare function containsFinalTag(text: string): boolean;
export declare function stripFinalTags(text: string): string;
