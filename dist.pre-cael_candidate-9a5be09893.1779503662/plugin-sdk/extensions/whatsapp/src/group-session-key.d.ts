import { type ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
declare function resolveWhatsAppGroupAccountThreadId(accountId: string): string;
export declare function resolveWhatsAppLegacyGroupSessionKey(params: {
    sessionKey: string;
    accountId?: string | null;
}): string | null;
export declare function resolveWhatsAppGroupSessionRoute(route: ResolvedAgentRoute): ResolvedAgentRoute;
export declare const testing: {
    resolveWhatsAppGroupAccountThreadId: typeof resolveWhatsAppGroupAccountThreadId;
    resolveWhatsAppLegacyGroupSessionKey: typeof resolveWhatsAppLegacyGroupSessionKey;
};
export { testing as __testing };
