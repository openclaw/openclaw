import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished } from "vitest";
import { decideTurnGrant } from "../gateway/operator-admission.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "../gateway/operator-run-recovery-source.codec.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import { DEFAULT_PARTICIPATION_TOOLS, type ParticipationCeiling } from "./participation-ceiling.js";

export function createParticipationTestAuthority(
  ceiling: ParticipationCeiling,
  scopes: readonly string[] = [],
) {
  const bound = {
    ...ceiling,
    tools: ceiling.tools ?? DEFAULT_PARTICIPATION_TOOLS,
    permission: ceiling.permission ?? ("guarded" as const),
    source: ceiling.source ?? {
      agentId: "main",
      sessionId: "test",
      lifecycleRevision: null,
      creatorProfileId: "creator",
      root: "/synthetic",
    },
  };
  return createAdmittedRunOperatorAuthority({
    canonicalIdentity: null,
    profileId: ceiling.profileId,
    scopes: [...scopes],
    grant: decideTurnGrant([...scopes]),
    participationCeiling: bound,
    recoverySnapshot: expectDefined(
      normalizeGatewayOperatorRecoverySnapshot({
        version: 2,
        participationCeiling: bound,
        profileId: bound.profileId,
        scopes: [...scopes],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "internal",
        authPolicy: {
          generation: "",
          grantGeneration: "fixture",
          role: "operator",
          authMethod: "trusted-proxy",
        },
      }),
      "test participant source",
    ),
  });
}

export function prepareParticipationTestRun(ceiling: ParticipationCeiling) {
  const authority = createParticipationTestAuthority(ceiling);
  const admission = prepareSystemAgentRunAdmission(
    {},
    "participation-test",
    "main",
    "test",
    undefined,
    authority,
  );
  onTestFinished(admission.close);
  return { preparedRunAdmission: admission, pluginExecutionAuthority: authority };
}
