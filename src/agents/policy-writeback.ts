import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import type { FailureRuleSuggestion } from "./failure-rule-suggestions.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_CLAUDE_FILENAME,
  DEFAULT_OPENCLAW_FILENAME,
} from "./workspace.js";

export type PolicyWritebackTargetName =
  | typeof DEFAULT_OPENCLAW_FILENAME
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_CLAUDE_FILENAME;

export type PolicyWritebackResult = {
  title: string;
  rule: string;
  key: string;
  path: string;
  targetName: PolicyWritebackTargetName;
  created: boolean;
  applied: boolean;
  duplicate: boolean;
};

const MANAGED_SECTION_HEADING = "## Harness Rules";

const DEFAULT_TARGET_ORDER: PolicyWritebackTargetName[] = [
  DEFAULT_OPENCLAW_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_CLAUDE_FILENAME,
];

function buildDefaultPolicyDocument(targetName: PolicyWritebackTargetName): string {
  return `# ${targetName}\n\n${MANAGED_SECTION_HEADING}\n\n`;
}

export function isPolicyWritebackTargetName(value: string): value is PolicyWritebackTargetName {
  return DEFAULT_TARGET_ORDER.includes(value as PolicyWritebackTargetName);
}

async function resolvePolicyWritebackPath(params: {
  workspaceDir: string;
  targetName?: PolicyWritebackTargetName;
}): Promise<{
  path: string;
  targetName: PolicyWritebackTargetName;
  exists: boolean;
}> {
  const workspaceDir = resolveUserPath(params.workspaceDir);
  if (params.targetName) {
    const explicitPath = path.join(workspaceDir, params.targetName);
    try {
      await fs.access(explicitPath);
      return { path: explicitPath, targetName: params.targetName, exists: true };
    } catch {
      return { path: explicitPath, targetName: params.targetName, exists: false };
    }
  }

  for (const candidate of DEFAULT_TARGET_ORDER) {
    const candidatePath = path.join(workspaceDir, candidate);
    try {
      await fs.access(candidatePath);
      return { path: candidatePath, targetName: candidate, exists: true };
    } catch {
      // try next target
    }
  }

  return {
    path: path.join(workspaceDir, DEFAULT_OPENCLAW_FILENAME),
    targetName: DEFAULT_OPENCLAW_FILENAME,
    exists: false,
  };
}

function appendHarnessRuleBlock(params: { content: string; suggestion: FailureRuleSuggestion }): {
  content: string;
  duplicate: boolean;
} {
  const marker = `<!-- harness-rule:${params.suggestion.key} -->`;
  if (
    params.content.includes(marker) ||
    params.content.includes(`- ${params.suggestion.rule}`) ||
    params.content.includes(params.suggestion.rule)
  ) {
    return { content: params.content, duplicate: true };
  }

  const normalized = params.content.trimEnd();
  const block = `${marker}\n- ${params.suggestion.rule}\n`;
  if (!normalized) {
    return {
      content: `${MANAGED_SECTION_HEADING}\n\n${block}`,
      duplicate: false,
    };
  }

  if (normalized.includes(MANAGED_SECTION_HEADING)) {
    return {
      content: `${normalized}\n\n${block}`,
      duplicate: false,
    };
  }

  return {
    content: `${normalized}\n\n${MANAGED_SECTION_HEADING}\n\n${block}`,
    duplicate: false,
  };
}

export async function applyFailureRuleSuggestionToPolicy(params: {
  workspaceDir: string;
  suggestion: FailureRuleSuggestion;
  targetName?: PolicyWritebackTargetName;
}): Promise<PolicyWritebackResult> {
  const resolved = await resolvePolicyWritebackPath({
    workspaceDir: params.workspaceDir,
    targetName: params.targetName,
  });

  const existingContent = resolved.exists
    ? await fs.readFile(resolved.path, "utf-8")
    : buildDefaultPolicyDocument(resolved.targetName);
  const next = appendHarnessRuleBlock({
    content: existingContent,
    suggestion: params.suggestion,
  });

  if (!next.duplicate) {
    await fs.writeFile(resolved.path, next.content, "utf-8");
  }

  return {
    title: params.suggestion.title,
    rule: params.suggestion.rule,
    key: params.suggestion.key,
    path: resolved.path,
    targetName: resolved.targetName,
    created: !resolved.exists,
    applied: !next.duplicate,
    duplicate: next.duplicate,
  };
}
