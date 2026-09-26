// Slack plugin module maps a failed approval resolve to what the clicker is told.
import {
  APPROVAL_AUTHORITY_REQUIRED_TEXT,
  isApprovalAuthorityError,
  isApprovalNotFoundError,
} from "openclaw/plugin-sdk/error-runtime";

/**
 * The clicker must see an outcome, and it has to be the true one. A refusal and a missing
 * approval both end the click, but only a transport failure is worth surfacing as an error:
 * the other two are answers the Gateway gave.
 */
export function describeSlackApprovalResolveFailure(error: unknown): {
  text: string;
  unexpected: boolean;
} {
  if (isApprovalAuthorityError(error)) {
    return { text: APPROVAL_AUTHORITY_REQUIRED_TEXT, unexpected: false };
  }
  if (isApprovalNotFoundError(error)) {
    return { text: "This approval is no longer pending.", unexpected: false };
  }
  return {
    text: "Could not reach the Gateway to resolve this approval. Try again.",
    unexpected: true,
  };
}
