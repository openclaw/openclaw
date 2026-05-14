import { parse as parseYaml } from "yaml";
import type { SpecOwner, SpecStep } from "./types.js";

type LegacyYamlRecord = Record<string, unknown>;

export type LegacySpecDraft = {
  id: string;
  title: string;
  type: string;
  status: string;
  version: number;
  owner?: SpecOwner;
  targetRepo?: string;
  steps: SpecStep[];
  artifacts: Record<string, string>;
};

export function parseLegacyYamlSpec(content: string): LegacySpecDraft {
  const raw = parseYaml(content);
  if (!isRecord(raw)) {
    throw new Error("legacy YAML spec must be an object");
  }

  const id = readString(raw.id) ?? "imported-spec";
  const title = readString(raw.title) ?? id;
  const type = readString(raw.type) ?? "daily_run";
  const status = readString(raw.status) ?? "draft";
  const version = readNumber(raw.version) ?? 1;
  const owner = readOwner(raw.owner);
  const targetRepo = readInputsDefault(raw.inputs, "targetRepo");
  const steps = readSteps(raw.steps);

  return {
    id,
    title,
    type,
    status,
    version,
    ...(owner ? { owner } : {}),
    ...(targetRepo ? { targetRepo } : {}),
    steps,
    artifacts: {
      "overview.md": renderOverview({ id, title, type, status, version, owner, raw }),
      "requirements.md": renderRequirements({ title, raw }),
      "design.md": renderDesign({ raw }),
      "tasks.md": renderTasks({ steps }),
      "coverage.md": renderCoverage({ raw, steps }),
      "runbook.md": renderRunbook({ id, raw }),
    },
  };
}

function renderOverview(params: {
  id: string;
  title: string;
  type: string;
  status: string;
  version: number;
  owner?: SpecOwner;
  raw: LegacyYamlRecord;
}): string {
  const source = isRecord(params.raw.source) ? params.raw.source : {};
  return [
    `# ${params.title}`,
    "",
    `- id: ${params.id}`,
    `- type: ${params.type}`,
    `- status: ${params.status}`,
    `- version: ${params.version}`,
    params.owner?.team ? `- owner team: ${params.owner.team}` : undefined,
    params.owner?.maintainer ? `- maintainer: ${params.owner.maintainer}` : undefined,
    readString(source.repo) ? `- source repo: ${readString(source.repo)}` : undefined,
    readString(source.path) ? `- source path: ${readString(source.path)}` : undefined,
    "",
    "This Markdown artifact was generated from a legacy YAML spec so it can be reviewed as a human-readable contract.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderRequirements(params: { title: string; raw: LegacyYamlRecord }): string {
  const validation = isRecord(params.raw.validation) ? params.raw.validation : {};
  const success = Array.isArray(validation.success) ? validation.success : [];
  const lines = [
    `# Requirements for ${params.title}`,
    "",
    "## Execution Requirements",
    "",
    "- The run must record every validation lane before producing a report.",
    "- Failed lanes must be diagnosed before any fix is proposed.",
    "- Code or spec changes must require approval before branch push or MR creation.",
    "",
    "## Success Signals",
    "",
    ...success.map((item) => `- ${String(item)}`),
  ];
  return lines.join("\n");
}

function renderDesign(params: { raw: LegacyYamlRecord }): string {
  const trigger = isRecord(params.raw.trigger) ? params.raw.trigger : {};
  const execution = isRecord(params.raw.execution) ? params.raw.execution : {};
  return [
    "# Design",
    "",
    "## Trigger",
    "",
    `- type: ${readString(trigger.type) ?? "manual"}`,
    readString(trigger.schedule) ? `- schedule: ${readString(trigger.schedule)}` : undefined,
    readString(trigger.timezone) ? `- timezone: ${readString(trigger.timezone)}` : undefined,
    "",
    "## Runtime",
    "",
    `- runtime: ${readString(execution.runtime) ?? "native-spec"}`,
    readNumber(execution.maxParallelSteps)
      ? `- max parallel steps: ${readNumber(execution.maxParallelSteps)}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTasks(params: { steps: SpecStep[] }): string {
  return [
    "# Tasks",
    "",
    "| id | type | title | dependsOn | outputs |",
    "| - | - | - | - | - |",
    ...params.steps.map((step) =>
      [
        "|",
        step.id,
        "|",
        step.type,
        "|",
        step.title.replaceAll("|", "/"),
        "|",
        step.dependsOn.length > 0 ? step.dependsOn.join(",") : "-",
        "|",
        step.outputs.length > 0 ? step.outputs.join(",") : "-",
        "|",
      ].join(" "),
    ),
  ].join("\n");
}

function renderCoverage(params: { raw: LegacyYamlRecord; steps: SpecStep[] }): string {
  const laneSteps = params.steps.filter((step) => step.id.startsWith("validate_"));
  return [
    "# Coverage",
    "",
    "## Validation Lanes",
    "",
    ...(laneSteps.length > 0
      ? laneSteps.map((step) => `- ${step.id}: ${step.title}`)
      : ["- No validation lane was detected."]),
    "",
    "## Gap Detection",
    "",
    "- Daily runs should report missing validation lanes, stale rules, uncovered changed paths, and flaky masking.",
  ].join("\n");
}

function renderRunbook(params: { id: string; raw: LegacyYamlRecord }): string {
  return [
    `# Runbook for ${params.id}`,
    "",
    "## Feishu Commands",
    "",
    `- /spec check ${params.id}`,
    `- /spec preview ${params.id}`,
    `- /spec run ${params.id}`,
    "",
    "## Approval",
    "",
    "- Branch push, MR creation, release, and changes to scheduled validation behavior require explicit approval.",
  ].join("\n");
}

function readSteps(value: unknown): SpecStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): SpecStep[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = readString(entry.id);
    if (!id) {
      return [];
    }
    const type = normalizeStepType(readString(entry.type));
    return [
      {
        id,
        type,
        title: readString(entry.title) ?? id,
        dependsOn: readStringArray(entry.dependsOn),
        outputs: readStringArray(entry.outputs),
        ...(readString(entry.task) ? { task: readString(entry.task) } : {}),
        ...(readString(entry.tool) ? { tool: readString(entry.tool) } : {}),
        ...(isRecord(entry.condition) ? { condition: JSON.stringify(entry.condition) } : {}),
      },
    ];
  });
}

function normalizeStepType(value: string | undefined): SpecStep["type"] {
  switch (value) {
    case "tool_task":
    case "agent_task":
    case "approval":
    case "validation":
    case "notify":
      return value;
    default:
      return "agent_task";
  }
}

function readOwner(value: unknown): SpecOwner | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const team = readString(value.team);
  const maintainer = readString(value.maintainer);
  if (!team && !maintainer) {
    return undefined;
  }
  return {
    ...(team ? { team } : {}),
    ...(maintainer ? { maintainer } : {}),
  };
}

function readInputsDefault(value: unknown, id: string): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const input of value) {
    if (!isRecord(input) || readString(input.id) !== id) {
      continue;
    }
    return readString(input.default);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function isRecord(value: unknown): value is LegacyYamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
