export declare function expectOpenDmPolicyConfigIssue<TAccount>(params: {
    collectIssues: (accounts: TAccount[]) => Array<{
        kind?: string;
    }>;
    account: TAccount;
}): void;
