import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-tools";

type XaiRuntimeModelCompat = {
  compat?: unknown;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  >;
};

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(model: T): T {
  const withCompat = applyXaiModelCompat(model);
  return {
    ...withCompat,
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      off: null,
    },
  };
}
