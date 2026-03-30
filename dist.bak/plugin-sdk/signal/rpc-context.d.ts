import { resolveSignalAccount } from "./accounts.js";
export declare function resolveSignalRpcContext(opts: {
    baseUrl?: string;
    account?: string;
    accountId?: string;
}, accountInfo?: ReturnType<typeof resolveSignalAccount>): {
    baseUrl: string;
    account: string | undefined;
};
