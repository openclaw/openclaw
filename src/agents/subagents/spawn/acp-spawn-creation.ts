import { getRuntimeConfig } from "../../../config/config.js";
import {
  attributeDelegatedSessionCreator,
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
} from "../../../config/sessions/session-entry-provenance.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSessionVisibilityAllowed } from "../../../gateway/session-sharing-policy.js";
import { captureSpawnParentLineage } from "./spawn-parent-lineage.js";

/** Capture creator and parent facts while keeping fresh-row policy live through commit. */
export function prepareAcpSpawnCreation(params: {
  cfg: OpenClawConfig;
  parentEntry?: SessionEntry;
  requesterAgentId: string;
  requesterSessionKey: string;
  creatorProfileId?: string;
  gitContributorProfileId?: string;
  expectedParentSessionId?: string;
  senderIsOwner?: boolean;
  assertActive?: SessionSourceAssertion;
}) {
  const lineage = captureSpawnParentLineage({
    parentEntry: params.parentEntry,
    expectedParentSessionId: params.expectedParentSessionId,
    senderIsOwner: params.senderIsOwner,
  });
  const assertCurrent = composeSessionSourceAssertion([params.assertActive], (assertSource) => {
    assertSource();
    if (
      params.parentEntry?.visibility === "draft" &&
      !isSessionVisibilityAllowed(getRuntimeConfig(), "draft")
    ) {
      throw new Error(
        "session visibility is disabled: draft. Continue in the existing Draft or ask an administrator to enable Draft creation.",
      );
    }
  });
  assertCurrent();
  return {
    assertCurrent,
    parentPatch: {
      ...lineage,
      ...(params.parentEntry?.visibility === "draft" ? { visibility: "draft" as const } : {}),
    },
    stamp: buildSessionCreationStamp({
      via: "spawn",
      actor: attributeDelegatedSessionCreator(
        { type: "agent", id: params.requesterAgentId },
        params.creatorProfileId,
      ),
      inheritedGitContributorProfileIds: inheritSessionGitContributorProfileIds(
        params.parentEntry,
        {
          config: params.cfg,
          agentId: params.requesterAgentId,
          sessionKey: params.requesterSessionKey,
          requesterProfileId: params.gitContributorProfileId,
        },
      ),
    }),
  };
}
