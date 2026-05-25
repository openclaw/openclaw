import {
  createKimiInlineReasoningSanitizer,
  isOllamaCloudKimiModelRef,
} from "./kimi-inline-reasoning.js";

export type OllamaVisibleContentStreamResolution =
  | { kind: "visible"; text: string }
  | { kind: "pending" };

export type OllamaVisibleContentSanitizer = {
  resolveStreamText(params: { text: string; final: boolean }): OllamaVisibleContentStreamResolution;
  sanitizeFinalText(text: string): string;
  shouldSanitizeFinalMessage(): boolean;
};

const noopVisibleContentSanitizer: OllamaVisibleContentSanitizer = {
  resolveStreamText(params) {
    return { kind: "visible", text: params.text };
  },
  sanitizeFinalText(text) {
    return text;
  },
  shouldSanitizeFinalMessage() {
    return true;
  },
};

export function createOllamaVisibleContentSanitizer(
  modelId: string,
): OllamaVisibleContentSanitizer {
  if (isOllamaCloudKimiModelRef(modelId)) {
    return createKimiInlineReasoningSanitizer();
  }
  return noopVisibleContentSanitizer;
}

export function sanitizeOllamaFinalVisibleContent(params: {
  modelId: string;
  text: string;
}): string {
  return createOllamaVisibleContentSanitizer(params.modelId).sanitizeFinalText(params.text);
}
