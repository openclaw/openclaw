import {
  PR_ATTRIBUTION_FOOTER,
  PR_ATTRIBUTION_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getUserPreferenceValues } from "../state/user-preferences.js";

export const PR_ATTRIBUTION_OPTOUT = "<!-- openclaw:attribution=off -->";
const log = createSubsystemLogger("agents/pr-attribution");

/** Caller supplies the verified requester, never a participant or publisher identity. */
export async function preparePrAttribution(params: {
  requesterProfileId?: string;
  sessionKey?: string;
  incognito?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<() => boolean> {
  if (
    !params.requesterProfileId ||
    params.incognito ||
    (params.sessionKey && isIncognitoSessionKey(params.sessionKey))
  ) {
    return () => false;
  }
  try {
    const prepared = await getUserPreferenceValues(
      [params.requesterProfileId],
      PR_ATTRIBUTION_PREFERENCE_KEY,
      { env: params.env },
    );
    const enabled = prepared.values.get(params.requesterProfileId) === true;
    // Optional disclosure is dropped when its prepared preference loses currency.
    // No per-effect database read or new publication authority layer.
    return () => enabled && prepared.isCurrent();
  } catch (error) {
    // Optional branding must not make an otherwise usable chat or publication fail.
    log.warn("failed to read PR attribution preference", { error });
    return () => false;
  }
}

/** Creation only. Existing PRs and manually removed footers are never repaired. */
export function appendPrAttribution(body: string, enabled: boolean): string {
  if (!enabled || body.includes(PR_ATTRIBUTION_OPTOUT) || body.includes(PR_ATTRIBUTION_FOOTER)) {
    return body;
  }
  return `${body.trimEnd()}

${PR_ATTRIBUTION_FOOTER}`;
}

export function buildPrAttributionPrompt(enabled: boolean): string {
  return enabled
    ? `PR attribution preference for this verified requester: enabled. When creating a new pull request (including gh or shell workflows), append this exact footer once: ${PR_ATTRIBUTION_FOOTER}
Omit it if the user opts out for that PR or its creation body contains ${PR_ATTRIBUTION_OPTOUT}. Never add it when reviewing or updating an existing PR, or restore a footer someone removed. Preserve human credit and work-session links. This preference is independent of Git co-author credit and GitHub publishing identity.`
    : "PR attribution preference for this request: off. Do not add the OpenClaw attribution footer to pull requests based on another participant's preference or an earlier turn. Preserve existing PR bodies and human credit.";
}
