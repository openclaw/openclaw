import type { RunEmbeddedAgentParams } from "./params.js";

export function resolveSkillWorkshopAttemptParams(
  params: Pick<
    RunEmbeddedAgentParams,
    | "skillWorkshopAutonomousCapture"
    | "skillWorkshopUpdateProposals"
    | "skillWorkshopOrigin"
    | "skillWorkshopProposalEnv"
    | "skillWorkshopProposalMutationBudget"
    | "skillWorkshopProposalOnly"
    | "skillWorkshopProposalRevision"
    | "skillLibraryAuthoring"
  >,
) {
  return {
    skillWorkshopAutonomousCapture: params.skillWorkshopAutonomousCapture,
    skillWorkshopUpdateProposals: params.skillWorkshopUpdateProposals,
    skillWorkshopProposalOnly: params.skillWorkshopProposalOnly,
    skillWorkshopProposalEnv: params.skillWorkshopProposalEnv,
    skillWorkshopOrigin: params.skillWorkshopOrigin,
    skillWorkshopProposalMutationBudget: params.skillWorkshopProposalMutationBudget,
    skillWorkshopProposalRevision: params.skillWorkshopProposalRevision,
    skillLibraryAuthoring: params.skillLibraryAuthoring,
  };
}
