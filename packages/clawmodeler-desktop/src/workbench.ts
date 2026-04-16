export type RunMode = "demo-full" | "full" | "diagnose" | "report-only";

export type QaSummary = {
  label: string;
  tone: "ready" | "blocked" | "unknown";
  blockers: string[];
};

export type WorkspaceArtifacts = {
  workspace: string;
  runId: string;
  manifest: Record<string, unknown> | null;
  qaReport: Record<string, unknown> | null;
  workflowReport: Record<string, unknown> | null;
  reportMarkdown: string | null;
  files: string[];
  filesTruncated: boolean;
};

export function normalizePathList(input: string): string[] {
  return input
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeScenarios(input: string): string[] {
  const values = input
    .split(/\s|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : ["baseline"];
}

export function buildFullWorkflowArgs(params: {
  workspace: string;
  inputs: string[];
  question: string;
  runId: string;
  scenarios: string[];
  skipBridges: boolean;
}): string[] {
  const args = [
    "workflow",
    "full",
    "--workspace",
    params.workspace,
    "--inputs",
    ...params.inputs,
    "--question",
    params.question,
    "--run-id",
    params.runId,
    "--scenarios",
    ...params.scenarios,
  ];
  if (params.skipBridges) {
    args.push("--skip-bridges");
  }
  return args;
}

export function summarizeQa(qaReport: Record<string, unknown> | null): QaSummary {
  if (!qaReport) {
    return { label: "No QA report", tone: "unknown", blockers: [] };
  }

  const rawBlockers = qaReport.blockers;
  const blockers = Array.isArray(rawBlockers) ? rawBlockers.map((item) => String(item)) : [];

  if (qaReport.export_ready === true) {
    return { label: "Export ready", tone: "ready", blockers };
  }
  if (qaReport.export_ready === false) {
    return { label: "Export blocked", tone: "blocked", blockers };
  }
  return { label: "QA status unknown", tone: "unknown", blockers };
}

export function countJsonLines(input: string | null): number {
  if (!input) {
    return 0;
  }
  return input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export function manifestOutputCategories(manifest: Record<string, unknown> | null): string[] {
  const outputs = manifest?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return [];
  }
  return Object.keys(outputs).toSorted();
}
