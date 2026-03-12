export type OpenClawVersion = {
    major: number;
    minor: number;
    patch: number;
    revision: number;
};
export declare function parseOpenClawVersion(raw: string | null | undefined): OpenClawVersion | null;
export declare function compareOpenClawVersions(a: string | null | undefined, b: string | null | undefined): number | null;
