import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { renderAgentFiles, renderKnowledgeFiles } from "./templates.js";
import type { WempScaffoldAnswers } from "./types.js";

export interface ScaffoldResult {
  agentRoot: string;
  created: string[];
  skipped: string[];
}

function writeIfMissing(filePath: string, content: string, created: string[], skipped: string[]) {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, content, "utf8");
  created.push(filePath);
}

export function scaffoldWempKf(
  workspaceRoot: string,
  answers: WempScaffoldAnswers,
  agentId = "wemp-kf",
): ScaffoldResult {
  const agentRoot = path.join(workspaceRoot, agentId);
  const knowledgeRoot = path.join(agentRoot, "knowledge");
  mkdirSync(knowledgeRoot, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  const agentFiles = renderAgentFiles(answers);
  const knowledgeFiles = renderKnowledgeFiles(answers);

  for (const [name, content] of Object.entries(agentFiles)) {
    writeIfMissing(path.join(agentRoot, name), content, created, skipped);
  }
  for (const [name, content] of Object.entries(knowledgeFiles)) {
    writeIfMissing(path.join(knowledgeRoot, name), content, created, skipped);
  }
  return { agentRoot, created, skipped };
}
