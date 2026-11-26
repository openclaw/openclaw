import type { CurrentInboundPromptContext } from "../internal-runtime-context.js";
import type { ResolvedContextSerialization } from "./resolve.js";

export type ContextSerializationReport = {
  mode: ResolvedContextSerialization["mode"];
  source: ResolvedContextSerialization["source"];
  defaultChars: number;
  serializedChars: number;
  removedSessionMessages: number;
  deduplicatedMessages: number;
};

export function selectCurrentInboundContext(params: {
  context: CurrentInboundPromptContext | undefined;
  serialization: ResolvedContextSerialization;
  preferResumableText?: boolean;
}): { text: string; report: ContextSerializationReport } {
  const context = params.context;
  const defaultText = params.preferResumableText
    ? (context?.resumableText ?? context?.text ?? "")
    : (context?.text ?? "");
  const compactText = params.preferResumableText
    ? (context?.compactResumableText ?? context?.compactText ?? defaultText)
    : (context?.compactText ?? defaultText);
  const isCompact = params.serialization.mode === "compact";
  const text = isCompact ? compactText : defaultText;
  return {
    text,
    report: {
      mode: params.serialization.mode,
      source: params.serialization.source,
      defaultChars: defaultText.length,
      serializedChars: text.length,
      removedSessionMessages: isCompact
        ? (context?.serializationStats?.removedSessionMessages ?? 0)
        : 0,
      deduplicatedMessages: isCompact
        ? (context?.serializationStats?.deduplicatedMessages ?? 0)
        : 0,
    },
  };
}
