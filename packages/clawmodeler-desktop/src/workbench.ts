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

const FRIENDLY_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /workspace is required/i,
    message: "Pick a workspace folder first. This is where ClawModeler stores your project files.",
  },
  {
    pattern: /no such file or directory|cannot find the (file|path)/i,
    message: "One of the paths doesn't exist. Double-check your workspace and input paths.",
  },
  {
    pattern: /permission denied/i,
    message:
      "ClawModeler can't read or write that location. Check folder permissions or pick another path.",
  },
  {
    pattern: /no module named ['"]?clawmodeler_engine['"]?/i,
    message:
      "The ClawModeler engine isn't installed. Run pip install -e . from the repo root, then retry.",
  },
  {
    pattern: /python3?: ?command not found|python3? is not recognized/i,
    message: "Python 3 isn't on PATH. Install Python 3.10+ and reopen ClawModeler.",
  },
  {
    pattern: /duckdb/i,
    message: "DuckDB isn't installed. Click Doctor to see which tools are missing.",
  },
  {
    pattern: /question\.json/i,
    message:
      "ClawModeler needs a question.json file describing what to analyze. Check the path you entered.",
  },
  {
    pattern: /method not allowed/i,
    message: "Internal routing error. Reload the window and try again.",
  },
];

export function friendlyError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Something went wrong. Open Doctor for details.";
  }
  for (const { pattern, message } of FRIENDLY_ERROR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return message;
    }
  }
  const firstLine = trimmed.split(/\r?\n/u).at(0) ?? trimmed;
  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}...` : firstLine;
}

export function deriveQuestionSavePath(workspace: string, currentQuestion: string): string {
  const trimmedQuestion = currentQuestion.trim();
  if (trimmedQuestion) {
    return trimmedQuestion;
  }
  const trimmedWorkspace = workspace.trim();
  if (!trimmedWorkspace) {
    return "question.json";
  }
  const separator = trimmedWorkspace.includes("\\") && !trimmedWorkspace.includes("/") ? "\\" : "/";
  const normalized = trimmedWorkspace.replace(/[/\\]+$/u, "");
  return `${normalized}${separator}question.json`;
}
