import { SPEC_ARTIFACT_NAMES, type SpecArtifactName, type SpecStep } from "./types.js";

export function extractMarkdownTitle(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function summarizeMarkdown(markdown: string): string | undefined {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("|"));
  const first = lines[0];
  if (!first) {
    return undefined;
  }
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

export function isSpecArtifactName(name: string): name is SpecArtifactName {
  return (SPEC_ARTIFACT_NAMES as readonly string[]).includes(name);
}

export function parseTasksMarkdown(markdown: string): SpecStep[] {
  const steps: SpecStep[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const table = parseTableStepLine(line);
    if (table) {
      steps.push(table);
      continue;
    }

    const heading = line.match(/^#{2,4}\s+([a-zA-Z0-9_.:-]+)\s*[-:]\s*(.+?)\s*$/);
    if (!heading?.[1] || !heading[2]) {
      continue;
    }
    steps.push({
      id: heading[1],
      type: "agent_task",
      title: heading[2].trim(),
      dependsOn: [],
      outputs: [],
    });
  }

  return dedupeSteps(steps);
}

function parseTableStepLine(line: string): SpecStep | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || /^\|\s*-+/.test(trimmed)) {
    return undefined;
  }
  const cells = trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
  if (cells.length < 3) {
    return undefined;
  }
  const [idCell, typeCell, titleCell, dependsCell = "", outputsCell = ""] = cells;
  if (!idCell || idCell.toLowerCase() === "id" || !/^[a-zA-Z0-9_.:-]+$/.test(idCell)) {
    return undefined;
  }
  return {
    id: idCell,
    type: normalizeStepType(typeCell),
    title: titleCell || idCell,
    dependsOn: parseListCell(dependsCell),
    outputs: parseListCell(outputsCell),
  };
}

function normalizeStepType(raw: string): SpecStep["type"] {
  switch (raw.trim()) {
    case "tool_task":
    case "agent_task":
    case "approval":
    case "validation":
    case "notify":
      return raw.trim() as SpecStep["type"];
    default:
      return "agent_task";
  }
}

function parseListCell(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== "-");
}

function dedupeSteps(steps: SpecStep[]): SpecStep[] {
  const seen = new Set<string>();
  const result: SpecStep[] = [];
  for (const step of steps) {
    if (seen.has(step.id)) {
      continue;
    }
    seen.add(step.id);
    result.push(step);
  }
  return result;
}
