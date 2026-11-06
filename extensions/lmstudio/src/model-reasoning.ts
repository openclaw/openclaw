export const LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const LMSTUDIO_OPENAI_COMPAT_REASONING_EFFORTS = [
  "none",
  ...LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS,
] as const;

export function buildLmstudioReasoningEffortMap(
  supportedReasoningEfforts: readonly string[],
): Record<string, string> | undefined {
  const disabled = supportedReasoningEfforts.includes("none") ? "none" : undefined;
  const max =
    LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS.findLast((option) =>
      supportedReasoningEfforts.includes(option),
    ) ?? supportedReasoningEfforts.find((option) => option !== "none");
  const map = {
    ...(disabled ? { off: disabled, none: disabled } : {}),
    ...(max ? { adaptive: max, max } : {}),
  };
  return Object.keys(map).length > 0 ? map : undefined;
}
