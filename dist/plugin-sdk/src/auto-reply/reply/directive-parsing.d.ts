export declare function skipDirectiveArgPrefix(raw: string): number;
export declare function takeDirectiveToken(raw: string, startIndex: number): {
    token: string | null;
    nextIndex: number;
};
