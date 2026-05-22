export { toSafeImportPath as toSafeRuntimeImportPath } from "./import-specifier.js";
export declare function resolveRuntimeImportSpecifier(baseUrl: string, parts: readonly string[]): string;
export declare function importRuntimeModule<T>(baseUrl: string, parts: readonly string[], importModule?: (specifier: string) => Promise<unknown>): Promise<T>;
