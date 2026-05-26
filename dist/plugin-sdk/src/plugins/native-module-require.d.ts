export declare function isJavaScriptModulePath(modulePath: string): boolean;
export declare function tryNativeRequireJavaScriptModule(modulePath: string, options?: {
    allowWindows?: boolean;
    aliasMap?: Record<string, string>;
    fallbackOnMissingDependency?: boolean;
    fallbackOnNativeError?: boolean;
}): {
    ok: true;
    moduleExport: unknown;
} | {
    ok: false;
};
export declare function withNativeRequireAliases<T>(aliasMap: Record<string, string> | undefined, run: () => T): T;
