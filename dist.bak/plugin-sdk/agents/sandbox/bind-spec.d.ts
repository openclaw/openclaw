type SplitBindSpec = {
    host: string;
    container: string;
    options: string;
};
export declare function splitSandboxBindSpec(spec: string): SplitBindSpec | null;
export {};
