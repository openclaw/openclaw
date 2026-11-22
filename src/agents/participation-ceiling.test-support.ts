import { onTestFinished } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import { DEFAULT_PARTICIPATION_TOOLS, type ParticipationCeiling } from "./participation-ceiling.js";

export function prepareParticipationTestRun(ceiling: ParticipationCeiling) {
  const authority = createAdmittedRunOperatorAuthority({
    profileId: ceiling.profileId,
    scopes: [],
    assertCurrent() {},
    participationCeiling: {
      ...ceiling,
      tools: ceiling.tools ?? DEFAULT_PARTICIPATION_TOOLS,
      permission: ceiling.permission ?? "guarded",
      source: ceiling.source ?? {
        agentId: "main",
        sessionId: "test",
        lifecycleRevision: null,
        creatorProfileId: "creator",
        root: "/synthetic",
      },
    },
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    "participation-test",
    "main",
    "test",
    undefined,
    authority,
  );
  onTestFinished(admission.close);
  return { preparedRunAdmission: admission };
}
