export type RuntimeContextDataRange = { start: number; end: number };

const dataRanges = Symbol("openclaw.runtimeContextDataRanges");
type Carrier = {
  content: unknown;
  [dataRanges]?: { text: string; ranges: readonly RuntimeContextDataRange[] };
};

/** In-memory only. A copy with different text must not inherit the old offsets. */
export function setRuntimeContextDataRanges(
  message: Carrier,
  ranges: readonly RuntimeContextDataRange[],
) {
  if (typeof message.content === "string" && ranges.length) {
    message[dataRanges] = { text: message.content, ranges };
  } else {
    delete message[dataRanges];
  }
}

export function getRuntimeContextDataRanges(message: Carrier) {
  const binding = message[dataRanges];
  return binding && binding.text === message.content ? binding.ranges : undefined;
}
