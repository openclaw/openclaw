//#region src/infra/map-size.d.ts
declare function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void;
//#endregion
export { pruneMapToMaxSize as t };