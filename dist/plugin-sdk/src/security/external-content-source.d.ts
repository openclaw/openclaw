export type HookExternalContentSource = "gmail" | "webhook";
export declare function resolveHookExternalContentSource(sessionKey: string): HookExternalContentSource | undefined;
export declare function mapHookExternalContentSource(source: HookExternalContentSource): "email" | "webhook";
export declare function isExternalHookSession(sessionKey: string): boolean;
