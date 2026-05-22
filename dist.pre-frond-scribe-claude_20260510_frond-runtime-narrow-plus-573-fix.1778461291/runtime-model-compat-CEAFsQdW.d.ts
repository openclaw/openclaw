//#region extensions/xai/runtime-model-compat.d.ts
type XaiRuntimeModelCompat = {
  compat?: unknown;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
};
declare function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(model: T): T;
//#endregion
export { applyXaiRuntimeModelCompat as t };