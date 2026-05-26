import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/auto-reply/inbound-debounce.d.ts
declare function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number;
type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  serializeImmediate?: boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
  onCancel?: (items: T[]) => void;
};
declare function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>): {
  enqueue: (item: T) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
  cancelKey: (key: string) => boolean;
};
//#endregion
export { createInboundDebouncer as n, resolveInboundDebounceMs as r, InboundDebounceCreateParams as t };