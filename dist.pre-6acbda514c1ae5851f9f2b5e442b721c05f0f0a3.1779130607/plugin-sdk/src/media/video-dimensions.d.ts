export type VideoDimensions = {
    width: number;
    height: number;
};
export declare function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined;
export declare function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined>;
