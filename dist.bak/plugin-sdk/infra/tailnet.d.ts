export type TailnetAddresses = {
    ipv4: string[];
    ipv6: string[];
};
export declare function isTailnetIPv4(address: string): boolean;
export declare function listTailnetAddresses(): TailnetAddresses;
export declare function pickPrimaryTailnetIPv4(): string | undefined;
export declare function pickPrimaryTailnetIPv6(): string | undefined;
