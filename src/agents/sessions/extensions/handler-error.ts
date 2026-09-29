import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { SessionMetadataCommittedError } from "../session-manager-metadata-error.js";
import type { ExtensionError } from "./types.js";

/** A missing committed view is a runtime fault; ordinary extension faults remain isolated. */
export function reportExtensionHandlerError(
  error: unknown,
  extensionPath: string,
  event: string,
  report: (error: ExtensionError) => void,
): void {
  if (error instanceof SessionMetadataCommittedError) {
    throw error;
  }
  report({
    extensionPath,
    event,
    error: coerceErrorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
