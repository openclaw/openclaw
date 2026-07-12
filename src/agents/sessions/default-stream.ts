import type { StreamFn } from "../runtime/index.js";

const defaultSessionStreamFns = new WeakSet<StreamFn>();

export function markDefaultSessionStreamFn<T extends StreamFn>(streamFn: T): T {
  defaultSessionStreamFns.add(streamFn);
  return streamFn;
}

export function isDefaultSessionStreamFn(streamFn: StreamFn | undefined): boolean {
  return streamFn !== undefined && defaultSessionStreamFns.has(streamFn);
}
