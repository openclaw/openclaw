export type ActionGate<T extends Record<string, boolean | undefined>> = (key: keyof T, defaultValue?: boolean) => boolean;
export declare function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
    baseActions?: T;
    accountActions?: T;
}): ActionGate<T>;
