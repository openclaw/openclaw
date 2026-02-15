type DelegationFleetEntry = {
  id: string;
  model?: string;
  description?: string;
};

export type DelegationProviderSlotEntry = {
  provider: string;
  available: number;
  active: number;
  pending: number;
  total: number;
  max: number;
};

function sanitizeCell(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "-";
  }
  return trimmed.replaceAll("|", "\\|");
}

function sanitizeNumber(value: number, minimum = 0): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.floor(value));
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

function buildProviderSlotsTable(rows: DelegationProviderSlotEntry[]): string {
  if (rows.length === 0) {
    return "_No provider limits configured._";
  }
  const lines = [
    "| Provider | Available | Active | Pending | Used | Max |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => {
      const available = sanitizeNumber(row.available);
      const active = sanitizeNumber(row.active);
      const pending = sanitizeNumber(row.pending);
      const total = sanitizeNumber(row.total);
      const max = sanitizeNumber(row.max, 1);
      return `| ${sanitizeCell(row.provider)} | ${available} | ${active} | ${pending} | ${total} | ${max} |`;
    }),
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
  providerSlots?: DelegationProviderSlotEntry[];
}): string {
  const tier = params.depth >= params.maxDepth ? 3 : params.depth >= params.maxDepth - 1 ? 2 : 1;
  const parentKey = params.parentKey.trim() || "unknown";
  const childSlotsAvailable = sanitizeNumber(params.childSlotsAvailable);
  const maxChildrenPerAgent = sanitizeNumber(params.maxChildrenPerAgent, 1);
  const globalSlotsAvailable = sanitizeNumber(params.globalSlotsAvailable);
  const maxConcurrent = sanitizeNumber(params.maxConcurrent, 1);

  if (tier === 3) {
    return [
      "## Delegation Tier: Leaf Worker",
      "",
      "- Complete your task directly. Do not attempt to spawn subagents.",
      "- Write results to files when that helps your parent verify work.",
      `- If blocked, message your parent at session key: ${parentKey}.`,
    ].join("\n");
  }

  const providerRows = params.providerSlots ?? [];
  const showProviderSlots = params.depth > 1 && providerRows.length > 0;
  const providerSection = showProviderSlots
    ? ["", "## Provider Slots", buildProviderSlotsTable(providerRows)]
    : [];

  const shared = [
    "## Spawn Limits",
    `- Current depth: ${params.depth}`,
    `- Maximum depth: ${params.maxDepth}`,
    `- Child slots available: ${childSlotsAvailable}/${maxChildrenPerAgent}`,
    `- Global subagent slots available: ${globalSlotsAvailable}/${maxConcurrent}`,
    `- Parent session key for messaging: ${parentKey}`,
    ...providerSection,
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
