import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

const QWEN_CLOSED_SOURCE_PATTERN =
  /^qwen\/qwen\d+(\.\d+){0,2}-(plus|max|flash)(-preview|-\d{4}(-\d{2}-\d{2})?)?$/;

export function isClosedSourceQwenModelRef(modelId: string): boolean {
  return QWEN_CLOSED_SOURCE_PATTERN.test(normalizeLowercaseStringOrEmpty(modelId));
}
