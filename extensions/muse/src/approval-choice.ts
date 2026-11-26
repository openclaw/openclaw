import type { ApprovalHandler } from "@muse-code/sdk";

export function selectApprovalChoice(
  request: Parameters<ApprovalHandler>[0],
  decision: string | null | undefined,
) {
  const wanted = decision === "allow-once" ? "approved" : "denied";
  const choice =
    request.availableChoices.find(
      (candidate) => candidate.decision === wanted && candidate.scope === "once",
    ) ??
    (wanted === "denied"
      ? request.availableChoices.find(
          (candidate) => candidate.decision === "denied" || candidate.decision === "abort",
        )
      : undefined);
  if (!choice) {
    throw new Error(`Muse offered no safe ${wanted} approval choice`);
  }
  return { choiceId: choice.choiceId };
}
