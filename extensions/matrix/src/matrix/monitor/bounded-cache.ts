import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.set(key, value);
  pruneMapToMaxSize(map, maxEntries);
}
