/** Preserve a supported effort, otherwise prefer the next higher effort. */
export function selectSupportedReasoningEffort<TEffort extends string>(params: {
  requested: TEffort;
  supportedEfforts: readonly string[];
  effortOrder: readonly TEffort[];
}): TEffort | undefined {
  const declared = new Set(params.supportedEfforts);
  const supported = params.effortOrder.filter((effort) => declared.has(effort));
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  const requestedRank = params.effortOrder.indexOf(params.requested);
  return (
    supported.find((effort) => params.effortOrder.indexOf(effort) >= requestedRank) ??
    supported.at(-1)
  );
}
