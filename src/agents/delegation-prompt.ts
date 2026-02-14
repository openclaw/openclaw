type DelegationFleetEntry = {
  id: string;
  model?: string;
  description?: string;
};

function sanitizeCell(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "-";
  }
  return trimmed.replaceAll("|", "\\|");
}

function buildFleetTable(fleet: DelegationFleetEntry[]): string {
  if (fleet.length === 0) {
    return "_No configured agents found._";
  }
  const lines = [
    "| Agent ID | Model | Description |",
    "| --- | --- | --- |",
    ...fleet.map(
      (entry) =>
        `| ${sanitizeCell(entry.id)} | ${sanitizeCell(entry.model)} | ${sanitizeCell(entry.description)} |`,
    ),
  ];
  return lines.join("\n");
}

export function buildDelegationPrompt(params: {
  depth: number;
  maxDepth: number;
  parentKey: string;
  childSlotsAvailable: number;
  maxChildrenPerAgent: number;
  globalSlotsAvailable: number;
  maxConcurrent: number;
  fleet: DelegationFleetEntry[];
}): string {
  const tier = params.depth >= params.maxDepth ? 3 : params.depth >= params.maxDepth - 1 ? 2 : 1;
  const parentKey = params.parentKey.trim() || "unknown";
  const childSlotsAvailable = Math.max(0, Math.floor(params.childSlotsAvailable));
  const maxChildrenPerAgent = Math.max(1, Math.floor(params.maxChildrenPerAgent));
  const globalSlotsAvailable = Math.max(0, Math.floor(params.globalSlotsAvailable));
  const maxConcurrent = Math.max(1, Math.floor(params.maxConcurrent));

  if (tier === 3) {
    return [
      "## Delegation Tier: Leaf Worker",
      "",
      "- Complete your task directly. Do not attempt to spawn subagents.",
      "- Write results to files when that helps your parent verify work.",
      `- If blocked, message your parent at session key: ${parentKey}.`,
    ].join("\n");
  }

  const shared = [
    "## Spawn Limits",
    `- Current depth: ${params.depth}`,
    `- Maximum depth: ${params.maxDepth}`,
    `- Child slots available: ${childSlotsAvailable}/${maxChildrenPerAgent}`,
    `- Global subagent slots available: ${globalSlotsAvailable}/${maxConcurrent}`,
    `- Parent session key for messaging: ${parentKey}`,
    "",
    "## Fleet",
    buildFleetTable(params.fleet),
  ];

  if (tier === 2) {
    return [
      "## Delegation Tier: Last Delegator",
      "",
      "- You may delegate, but children are leaf workers and cannot spawn further.",
      "- Prefer cheaper/faster models for narrow tasks.",
      "- Keep decomposition shallow and focused on concrete deliverables.",
      "",
      ...shared,
    ].join("\n");
  }

  return [
    "## Delegation Tier: Full Orchestrator",
    "",
    "## Delegation Philosophy",
    "- Break work into independent, testable chunks.",
    "- Delegate parallelizable tasks and aggregate findings.",
    "- Escalate blockers to the parent session with clear context.",
    "",
    ...shared,
  ].join("\n");
}
