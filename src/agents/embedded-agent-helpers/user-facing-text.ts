import { renderBillingFailureCopy, renderSanitizedUserFacingText } from "../failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../harness/errors.js";
import { sanitizeUserFacingText } from "./sanitize-user-facing-text.js";

/** Compose internal-text stripping with the canonical failover copy renderer. */
export function renderUserFacingText(
  text: unknown,
  opts?: { errorContext?: boolean; conversationContext?: string; streaming?: boolean },
): string {
  const billingCopy = opts?.errorContext ? renderBillingFailureCopy(text) : undefined;
  return renderSanitizedUserFacingText(sanitizeUserFacingText(billingCopy ?? text, opts), opts);
}

/** Only an explicit preflight copy can replace private diagnostic detail. */
export function renderAgentHarnessPreflightUserMessage(error: unknown): string | undefined {
  if (!isAgentHarnessPreflightError(error) || error.userMessage === undefined) {
    return undefined;
  }
  return renderUserFacingText(error.userMessage, { errorContext: true });
}
