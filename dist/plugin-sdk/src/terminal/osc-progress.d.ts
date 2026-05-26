export type OscProgressController = {
    setIndeterminate: (label: string) => void;
    setPercent: (label: string, percent: number) => void;
    clear: () => void;
};
export declare function supportsOscProgress(env: NodeJS.ProcessEnv, isTty: boolean): boolean;
export declare function createOscProgressController(params: {
    env: NodeJS.ProcessEnv;
    isTty: boolean;
    write: (chunk: string) => void;
}): OscProgressController;
