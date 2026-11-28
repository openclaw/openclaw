import { renderSanitizedUserFacingText } from "../failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../harness/errors.js";
import { sanitizeUserFacingText } from "./sanitize-user-facing-text.js";

/** Compose internal-text stripping with the canonical failover copy renderer. */
export function renderUserFacingText(
  text: unknown,
  opts?: { errorContext?: boolean; conversationContext?: string; streaming?: boolean },
): string {
  return renderSanitizedUserFacingText(sanitizeUserFacingText(text, opts), opts);
}

/** Only an explicit preflight copy can replace private diagnostic detail. */
export function renderAgentHarnessPreflightUserMessage(
  error: unknown,
  options?: { audience: "desktop" },
): string | undefined {
  if (!isAgentHarnessPreflightError(error)) {
    return undefined;
  }
  const message =
    (options?.audience === "desktop" ? error.desktopMessage : undefined) ?? error.userMessage;
  return message === undefined ? undefined : renderUserFacingText(message, { errorContext: true });
}
