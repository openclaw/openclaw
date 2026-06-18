export function renderIssueFixAgentPrTitle(params: {
  issueNumber: number;
  scope?: string | null;
}): string {
  return params.scope
    ? `fix(${params.scope}): address issue #${params.issueNumber}`
    : `fix: address issue #${params.issueNumber}`;
}

export function renderIssueFixAgentPrBody(params: {
  issueNumber: number;
  issueUrl: string;
  runId: string;
  touchedFiles: readonly string[];
  verification: readonly string[];
  proofGaps?: readonly string[];
}): string {
  const touched = params.touchedFiles.length > 0 ? params.touchedFiles : ["No files recorded yet"];
  const verification =
    params.verification.length > 0 ? params.verification : ["Verification has not run yet"];
  const proofGaps = params.proofGaps?.length
    ? params.proofGaps
    : ["Final maintainer review and merge decision"];
  return [
    "## Summary",
    "",
    `- Addresses issue #${params.issueNumber}.`,
    "- Created by the local issue-fix agent as a draft PR.",
    "",
    "## Touched Surface",
    "",
    ...touched.map((file) => `- \`${file}\``),
    "",
    "## Verification",
    "",
    ...verification.map((command) => `- \`${command}\``),
    "",
    "## Known Proof Gaps",
    "",
    ...proofGaps.map((gap) => `- ${gap}`),
    "",
    `Automation run: \`${params.runId}\``,
    `Closes: ${params.issueUrl}`,
    "",
  ].join("\n");
}
