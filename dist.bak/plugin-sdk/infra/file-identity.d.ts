export type FileIdentityStat = {
    dev: number | bigint;
    ino: number | bigint;
};
export declare function sameFileIdentity(left: FileIdentityStat, right: FileIdentityStat, platform?: NodeJS.Platform): boolean;
