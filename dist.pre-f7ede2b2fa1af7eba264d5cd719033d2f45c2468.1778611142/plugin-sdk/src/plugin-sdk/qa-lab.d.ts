type FacadeModule = {
    isQaLabCliAvailable: () => boolean;
    registerQaLabCli: (program: unknown) => void;
};
export declare const registerQaLabCli: FacadeModule["registerQaLabCli"];
export declare const isQaLabCliAvailable: FacadeModule["isQaLabCliAvailable"];
export {};
