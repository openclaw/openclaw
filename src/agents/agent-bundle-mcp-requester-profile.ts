import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import type { McpRequesterProfile } from "./agent-bundle-mcp-types.js";

/**
 * Binds a chat turn's verified Gateway profile to the run's operator authority. Each use
 * rechecks that the profile still holds that live authority, so a revoked or reassigned
 * profile selects no requester credentials.
 */
export function bindRunRequesterProfile(
  profileId: string | undefined,
  admittedRunContext: AdmittedRunContext | undefined,
): McpRequesterProfile | undefined {
  if (!profileId) {
    return undefined;
  }
  return Object.freeze({
    profileId,
    assertCurrent: () => {
      const authority = readAdmittedRunOperatorAuthority(admittedRunContext);
      if (authority?.profileId !== profileId) {
        throw new Error("The requester profile no longer holds this run's operator authority.");
      }
      authority.assertCurrent();
    },
  });
}
