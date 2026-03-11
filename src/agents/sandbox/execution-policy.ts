import { createHash } from "node:crypto";
import { expandToolGroups } from "../tool-policy.js";
import { DEFAULT_SANDBOX_EXECUTION_TEMPLATE, PYTHON_STDLIB_ROOT_MODULES } from "./constants.js";
import type { SandboxExecutionConfig, SandboxToolPolicy } from "./types.js";

export type SandboxPythonImportUsage = {
  line: number;
  statement: string;
  module: string;
  root: string;
  category: "import" | "dependency" | "relative";
};

function normalizeNameList(values?: string[]): string[] {
  if (!values) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.toSorted();
}

function normalizeSandboxSource(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function normalizeCommentValue(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function classifyImportRoot(root: string): SandboxPythonImportUsage["category"] {
  if (root.startsWith(".")) {
    return "relative";
  }
  return PYTHON_STDLIB_ROOT_MODULES.has(root) ? "import" : "dependency";
}

function parseImportSegment(moduleRef: string): string | null {
  const withoutAlias = moduleRef.split(/\s+as\s+/i)[0]?.trim() ?? "";
  if (!withoutAlias) {
    return null;
  }
  return withoutAlias;
}

function parseImportLine(line: string, lineNumber: number): SandboxPythonImportUsage[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return [];
  }

  const fromMatch = trimmed.match(/^from\s+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)\s+import\s+/);
  if (fromMatch?.[1]) {
    const module = fromMatch[1];
    const root = module.startsWith(".") ? module : (module.split(".")[0] ?? module);
    return [
      {
        line: lineNumber,
        statement: trimmed,
        module,
        root,
        category: classifyImportRoot(root),
      },
    ];
  }

  const importMatch = trimmed.match(/^import\s+(.+)$/);
  if (!importMatch?.[1]) {
    return [];
  }

  const usages: SandboxPythonImportUsage[] = [];
  for (const segment of importMatch[1].split(",")) {
    const module = parseImportSegment(segment);
    if (!module) {
      continue;
    }
    const root = module.startsWith(".") ? module : (module.split(".")[0] ?? module);
    usages.push({
      line: lineNumber,
      statement: trimmed,
      module,
      root,
      category: classifyImportRoot(root),
    });
  }
  return usages;
}

export function extractPythonImportUsages(source: string): SandboxPythonImportUsage[] {
  return normalizeSandboxSource(source)
    .split("\n")
    .flatMap((line, index) => parseImportLine(line, index + 1));
}

export function renderSandboxPythonExecutionTemplate(params: {
  code: string;
  objective?: string;
  requiredTools?: string[];
  template?: string;
}): string {
  const template = params.template ?? DEFAULT_SANDBOX_EXECUTION_TEMPLATE;
  const requiredTools = normalizeNameList(params.requiredTools);
  const body = normalizeSandboxSource(params.code) || "pass\n";
  const sourceHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return [
    `# OpenClaw sandbox template: ${template}`,
    `# Objective: ${normalizeCommentValue(params.objective, "generated research task")}`,
    `# Required tools: ${requiredTools.length > 0 ? requiredTools.join(", ") : "none"}`,
    `# Source hash: ${sourceHash}`,
    "",
    body,
  ].join("\n");
}

function formatValidationIssues(issues: string[]): string {
  return [
    "Sandbox execution policy rejected generated Python code:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

export function validateSandboxPythonExecution(params: {
  code: string;
  objective?: string;
  requiredTools?: string[];
  template?: string;
  execution: SandboxExecutionConfig;
  tools?: SandboxToolPolicy;
}): {
  rendered: string;
  imports: SandboxPythonImportUsage[];
  normalizedCode: string;
} {
  const normalizedCode = normalizeSandboxSource(params.code);
  const issues: string[] = [];

  if (!normalizedCode.trim()) {
    issues.push("source is empty; provide at least one executable or declarative statement.");
  }

  const template = params.template ?? params.execution.template;
  if (template !== params.execution.template) {
    issues.push(
      `template "${template}" is not allowed; expected sandbox.execution.template=${params.execution.template}.`,
    );
  }

  const importAllow = new Set(normalizeNameList(params.execution.imports.allow));
  const importDeny = new Set(normalizeNameList(params.execution.imports.deny));
  const dependencyAllow = new Set(normalizeNameList(params.execution.dependencies.allow));
  const dependencyDeny = new Set(normalizeNameList(params.execution.dependencies.deny));

  const imports = extractPythonImportUsages(normalizedCode);
  for (const usage of imports) {
    if (usage.category === "relative") {
      issues.push(`line ${usage.line}: relative import "${usage.module}" is not allowed.`);
      continue;
    }
    if (usage.category === "import") {
      if (importDeny.has(usage.root)) {
        issues.push(
          `line ${usage.line}: import "${usage.root}" is blocked by sandbox.execution.imports.deny.`,
        );
        continue;
      }
      if (!importAllow.has(usage.root)) {
        issues.push(
          `line ${usage.line}: import "${usage.root}" is not allowlisted by sandbox.execution.imports.allow.`,
        );
      }
      continue;
    }
    if (dependencyDeny.has(usage.root)) {
      issues.push(
        `line ${usage.line}: dependency "${usage.root}" is blocked by sandbox.execution.dependencies.deny.`,
      );
      continue;
    }
    if (!dependencyAllow.has(usage.root)) {
      issues.push(
        `line ${usage.line}: dependency "${usage.root}" is not allowlisted by sandbox.execution.dependencies.allow.`,
      );
    }
  }

  const requiredTools = normalizeNameList(params.requiredTools);
  const toolAllow = new Set(expandToolGroups(params.tools?.allow ?? []));
  const toolDeny = new Set(expandToolGroups(params.tools?.deny ?? []));
  for (const tool of requiredTools) {
    if (toolDeny.has(tool)) {
      issues.push(`tool "${tool}" is blocked by sandbox tool deny policy.`);
      continue;
    }
    if (toolAllow.size > 0 && !toolAllow.has(tool)) {
      issues.push(`tool "${tool}" is not allowlisted by sandbox tool policy.`);
    }
  }

  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }

  return {
    rendered: renderSandboxPythonExecutionTemplate({
      code: normalizedCode,
      objective: params.objective,
      requiredTools,
      template,
    }),
    imports,
    normalizedCode,
  };
}
