export const OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE = "output_text";
export const AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE = "text";
export const OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE = "response.output_text.delta";
export const AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE = "response.text.delta";

export type ResponsesTextContentPartType =
  | typeof OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE
  | typeof AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE;

export type ResponsesTextDeltaEventType =
  | typeof OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE
  | typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;

export type AzureResponsesTextContentPart = {
  type: typeof AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE;
  text: string;
};

export type AzureResponsesTextDeltaEvent = {
  type: typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;
  delta: string;
};

export function isResponsesTextContentPartType(
  type: unknown,
): type is ResponsesTextContentPartType {
  return (
    type === OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE ||
    type === AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE
  );
}

export function isResponsesTextDeltaEventType(type: unknown): type is ResponsesTextDeltaEventType {
  return (
    type === OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE ||
    type === AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE
  );
}

export function isAzureResponsesTextDeltaEventType(
  type: unknown,
): type is typeof AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE {
  return type === AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE;
}

export function isAzureResponsesTextDeltaEvent(event: {
  type?: unknown;
  delta?: unknown;
}): event is AzureResponsesTextDeltaEvent {
  return isAzureResponsesTextDeltaEventType(event.type) && typeof event.delta === "string";
}

export type ResponsesMessageSnapshotCollapse = { kind: "extend"; text: string } | { kind: "keep" };

type ResponsesMessageSnapshotLineage = {
  phase: string | undefined;
  itemId: string | undefined;
  outputIndex: number | undefined;
};

// Some openai-responses providers re-emit one assistant output slot as cumulative
// snapshots — each a strict prefix-superset of the previous one — instead of one
// final message item. A same-output-slot or same-item, same-phase strict
// extension replaces the prior text block, or the visible reply repeats once per
// snapshot (#91959).
// Extension-only on purpose: equal or shrinking adjacent items stay distinct
// (the Responses protocol allows multiple message items per response), so a
// false positive can only merge rendering — it can never lose text.
// `prior` must be the immediately preceding output item: collapsing across
// reasoning/function_call boundaries would drop real post-tool messages and
// orphan reasoning items, which OpenAI replay rejects.
export function isResponsesMessageSnapshotLineage(params: {
  prior: ResponsesMessageSnapshotLineage | null;
  nextPhase: string | undefined;
  nextItemId: string | undefined;
  nextOutputIndex: number | undefined;
}): boolean {
  const { prior } = params;
  if (!prior || prior.phase !== params.nextPhase) {
    return false;
  }
  if (prior.itemId && params.nextItemId && prior.itemId === params.nextItemId) {
    return true;
  }
  if (prior.outputIndex !== undefined && params.nextOutputIndex !== undefined) {
    return prior.outputIndex === params.nextOutputIndex;
  }
  // Older compatibility fixtures and non-conforming provider streams may omit
  // output_index; keep the original adjacent-prefix behavior for those streams.
  return prior.outputIndex === undefined && params.nextOutputIndex === undefined;
}

export function resolveResponsesMessageSnapshotCollapse(params: {
  prior: ({ text: string } & ResponsesMessageSnapshotLineage) | null;
  nextText: string;
  nextPhase: string | undefined;
  nextItemId: string | undefined;
  nextOutputIndex: number | undefined;
}): ResponsesMessageSnapshotCollapse {
  const { prior, nextText } = params;
  if (
    !prior?.text ||
    !nextText ||
    !isResponsesMessageSnapshotLineage({
      prior,
      nextPhase: params.nextPhase,
      nextItemId: params.nextItemId,
      nextOutputIndex: params.nextOutputIndex,
    })
  ) {
    return { kind: "keep" };
  }
  if (nextText.length > prior.text.length && nextText.startsWith(prior.text)) {
    return { kind: "extend", text: nextText };
  }
  return { kind: "keep" };
}
