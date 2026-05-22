type ParsedVcard = {
    name?: string;
    phones: string[];
};
export declare function parseVcard(vcard?: string): ParsedVcard;
export {};
