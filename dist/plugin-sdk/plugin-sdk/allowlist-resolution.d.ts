export type BasicAllowlistResolutionEntry = {
    input: string;
    resolved: boolean;
    id?: string;
    name?: string;
    note?: string;
};
export declare function mapBasicAllowlistResolutionEntries(entries: BasicAllowlistResolutionEntry[]): BasicAllowlistResolutionEntry[];
export declare function mapAllowlistResolutionInputs<T>(params: {
    inputs: string[];
    mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]>;
