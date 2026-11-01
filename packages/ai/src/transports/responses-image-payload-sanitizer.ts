/**
 * Sanitizes OpenAI Responses payloads before transport. Invalid inline images
 * are replaced with text placeholders so the request remains valid and
 * auditable.
 */
import { getAiTransportHost } from "../host.js";
import { sanitizeResponsesImageInput } from "./responses-image-input-sanitizer.js";

export {
  buildResponsesInputImage,
  isSanitizedFrozenResponsesInput,
} from "./responses-image-input-sanitizer.js";

/** Sanitize inline image fields inside a Responses API payload. */
export function sanitizeResponsesImagePayload<T extends Record<string, unknown>>(params: T): T {
  if (!Array.isArray(params.input)) {
    return params;
  }
  return {
    ...params,
    input: sanitizeResponsesImageInput(params.input, getAiTransportHost().immutableData),
  };
}
