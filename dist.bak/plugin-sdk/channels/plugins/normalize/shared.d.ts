export declare function trimMessagingTarget(raw: string): string | undefined;
export declare function looksLikeHandleOrPhoneTarget(params: {
    raw: string;
    prefixPattern: RegExp;
    phonePattern?: RegExp;
}): boolean;
