//#region extensions/xai/runtime-model-compat.d.ts
type XaiRuntimeModelCompat = {
  compat?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: XaiThinkingLevelMap;
};
type XaiThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
declare function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(model: T): T & {
  compat: Record<string, unknown>;
  thinkingLevelMap: XaiThinkingLevelMap;
};
//#endregion
export { applyXaiRuntimeModelCompat as t };