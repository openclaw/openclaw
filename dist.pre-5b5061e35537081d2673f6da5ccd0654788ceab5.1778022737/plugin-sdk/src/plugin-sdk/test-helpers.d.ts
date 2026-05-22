import { type RmOptions } from "node:fs";
export declare function createPluginSdkTestHarness(options?: {
    cleanup?: RmOptions;
}): {
    createTempDir: (prefix: string) => Promise<string>;
    createTempDirSync: (prefix: string) => string;
};
