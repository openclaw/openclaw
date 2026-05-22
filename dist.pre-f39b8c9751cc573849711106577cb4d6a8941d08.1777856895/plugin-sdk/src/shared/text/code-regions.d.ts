export interface CodeRegion {
    start: number;
    end: number;
}
export declare function findCodeRegions(text: string): CodeRegion[];
export declare function isInsideCode(pos: number, regions: CodeRegion[]): boolean;
