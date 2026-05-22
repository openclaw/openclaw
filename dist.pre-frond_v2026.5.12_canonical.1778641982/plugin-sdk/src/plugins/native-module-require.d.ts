export declare function isJavaScriptModulePath(modulePath: string): boolean;
export declare function tryNativeRequireJavaScriptModule(modulePath: string, options?: {
    allowWindows?: boolean;
    fallbackOnMissingDependency?: boolean;
}): {
    ok: true;
    moduleExport: unknown;
} | {
    ok: false;
};
