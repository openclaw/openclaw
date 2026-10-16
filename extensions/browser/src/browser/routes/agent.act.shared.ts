const ACT_KINDS = [
  "batch",
  "click",
  "clickCoords",
  "close",
  "drag",
  "evaluate",
  "fill",
  "hover",
  "insertText",
  "scrollIntoView",
  "press",
  "resize",
  "select",
  "type",
  "wait",
] as const;

export type ActKind = (typeof ACT_KINDS)[number];

export function isActKind(value: unknown): value is ActKind {
  if (typeof value !== "string") {
    return false;
  }
  return (ACT_KINDS as readonly string[]).includes(value);
}
