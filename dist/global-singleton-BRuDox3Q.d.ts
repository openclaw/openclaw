//#region src/shared/global-singleton.d.ts
declare function resolveGlobalSingleton<T>(key: symbol, create: () => T): T;
declare function resolveGlobalMap<TKey, TValue>(key: symbol): Map<TKey, TValue>;
//#endregion
export { resolveGlobalSingleton as n, resolveGlobalMap as t };