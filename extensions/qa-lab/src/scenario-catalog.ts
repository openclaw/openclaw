import fs from "node:fs";
import path from "node:path";

export type QaSeedScenario = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  successCriteria: string[];
  docsRefs?: string[];
  codeRefs?: string[];
};

export type QaBootstrapScenarioCatalog = {
  kickoffTask: string;
  scenarios: QaSeedScenario[];
};

function walkUpDirectories(start: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

function resolveRepoFile(relativePath: string): string | null {
  for (const dir of walkUpDirectories(import.meta.dirname)) {
    const candidate = path.join(dir, relativePath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function readTextFile(relativePath: string): string {
  const resolved = resolveRepoFile(relativePath);
  if (!resolved) {
    return "";
  }
  return fs.readFileSync(resolved, "utf8").trim();
}

function readScenarioFile(relativePath: string): QaSeedScenario[] {
  const resolved = resolveRepoFile(relativePath);
  if (!resolved) {
    return [];
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8")) as QaSeedScenario[];
}

export function readQaBootstrapScenarioCatalog(): QaBootstrapScenarioCatalog {
  return {
    kickoffTask: readTextFile("qa/QA_KICKOFF_TASK.md"),
    scenarios: readScenarioFile("qa/seed-scenarios.json"),
  };
}
