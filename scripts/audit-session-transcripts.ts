#!/usr/bin/env -S node --import tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

type TranscriptToolCall = {
  id: string;
  name: string;
  line: number;
  timestamp?: string;
  arguments?: Record<string, unknown>;
};

type TranscriptToolResult = {
  toolCallId: string;
  toolName?: string;
  line: number;
  timestamp?: string;
  exitCode?: number;
  text: string;
};

type TranscriptAssistantText = {
  line: number;
  timestamp?: string;
  text: string;
};

export type PreflightCheckKey =
  | "binary_check"
  | "aws_identity"
  | "kubectl_context"
  | "kubectl_namespace";

export type TranscriptAudit = {
  path: string;
  sessionId?: string;
  model?: string;
  userTurns: number;
  assistantTurns: number;
  records: number;
  fileBytes?: number;
  toolCalls: number;
  execCalls: number;
  execFailures: number;
  skillReads: string[];
  configuredSkills: string[];
  retrieval: {
    score: number;
    reads: string[];
    usedKnowledgeIndex: boolean;
    usedRunbookMap: boolean;
    usedRepoRootModel: boolean;
    usedIncidentDossier: boolean;
    usedNotionPostmortemIndex: boolean;
  };
  delegation: {
    score: number;
    toolCounts: Record<string, number>;
  };
  bloat: {
    largeTranscript: boolean;
    hugeTranscript: boolean;
    cappedReadMarkers: number;
    repeatedExecFailures: number;
    repeatedExecFailureSamples: string[];
  };
  preflight: {
    score: number;
    satisfied: PreflightCheckKey[];
    missing: PreflightCheckKey[];
    firstAnalysisLine?: number;
  };
  discussion: {
    speculationBeforeEvidence: boolean;
    firstSuccessfulExecLine?: number;
    firstFailedExecLine?: number;
    blockedReplyLine?: number;
    blockedReplyHasExactError: boolean;
    blockedReplyHasNextChecks: boolean;
    blockedReplyHasSpeculation: boolean;
    blockedReplyIsLong: boolean;
  };
};

export type TranscriptAuditSummary = {
  scannedPaths: string[];
  transcriptCount: number;
  aggregate: {
    userTurns: number;
    assistantTurns: number;
    execCalls: number;
    execFailures: number;
    sessionsWithSkills: number;
    sessionsWithConfiguredSkills: number;
    sessionsWithVisibleSkillReads: number;
    sessionsWithSpeculationBeforeEvidence: number;
    sessionsWithBlockedReplies: number;
    sessionsWithPreflight: number;
    sessionsWithStrongPreflight: number;
    sessionsWithRetrieval: number;
    sessionsWithDelegation: number;
    sessionsWithLargeTranscripts: number;
    sessionsWithHugeTranscripts: number;
  };
  skills: Array<{ name: string; count: number }>;
  recommendations: string[];
  sessions: TranscriptAudit[];
};

const PRELUDE_CHECKS: Array<{ key: PreflightCheckKey; re: RegExp }> = [
  { key: "binary_check", re: /\b(command\s+-v|type\s+-a|which)\b/i },
  { key: "aws_identity", re: /\baws\s+sts\s+get-caller-identity\b/i },
  { key: "kubectl_context", re: /\bkubectl(?:\s+--context\s+\S+)?\s+config\s+current-context\b/i },
  { key: "kubectl_namespace", re: /\bkubectl(?:\s+--context\s+\S+)?\s+get\s+ns\b/i },
];

const SPECULATION_RE =
  /(?:^|\n)\s*(hypotheses?(?:\s*\([^)]*\))?|likely cause|root cause|most likely|ranked)\s*:/i;
const NEXT_CHECKS_RE =
  /(?:next actions?|next checks?|recommended next commands|please run and paste|if you want, next exact checks)/i;
const DELEGATION_TOOL_NAMES = new Set([
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
]);
const RETRIEVAL_PATH_RULES = [
  { name: "knowledge-index", re: /knowledge-index\.md$/i },
  { name: "runbook-map", re: /runbook-map\.md$/i },
  { name: "repo-root-model", re: /repo-root-model\.md$/i },
  { name: "incident-dossier", re: /incident-dossier/i },
  { name: "notion-postmortem-index", re: /notion-postmortem-index\.md$/i },
] as const;
const LARGE_TRANSCRIPT_BYTES = 1_000_000;
const HUGE_TRANSCRIPT_BYTES = 5_000_000;

type SessionMetadata = {
  model?: string;
  configuredSkills: string[];
};

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getTextBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      const trimmed = record.text.trim();
      if (trimmed) {
        blocks.push(trimmed);
      }
    }
  }
  return blocks;
}

function getToolCalls(content: unknown): TranscriptToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: TranscriptToolCall[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (
      record.type !== "toolCall" ||
      typeof record.id !== "string" ||
      typeof record.name !== "string"
    ) {
      continue;
    }
    calls.push({
      id: record.id,
      name: record.name,
      line: 0,
      arguments:
        record.arguments && typeof record.arguments === "object"
          ? (record.arguments as Record<string, unknown>)
          : undefined,
    });
  }
  return calls;
}

function getToolResultText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const record = entry as { text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseExitCode(message: Record<string, unknown>): number | undefined {
  const details = message.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const exitCode = (details as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" ? exitCode : undefined;
}

function inferSkillName(skillPath: string): string {
  const normalized = skillPath.replace(/\\/g, "/");
  if (normalized.endsWith("/SKILL.md")) {
    const parent = normalized.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    return path.posix.basename(parent) || normalized;
  }
  return path.posix.basename(normalized);
}

function inspectCommandForPreflight(command: string): PreflightCheckKey[] {
  const matches = new Set<PreflightCheckKey>();
  for (const check of PRELUDE_CHECKS) {
    if (check.re.test(command)) {
      matches.add(check.key);
    }
  }
  return [...matches];
}

function listMissingChecks(satisfied: Set<PreflightCheckKey>): PreflightCheckKey[] {
  return PRELUDE_CHECKS.map((entry) => entry.key).filter((key) => !satisfied.has(key));
}

function hasExactErrorReference(text: string, errorText: string): boolean {
  const candidates = errorText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("(Command exited with code"));
  return candidates.some((candidate) => text.includes(candidate));
}

function countNonEmptyLines(text: string): number {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export function analyzeTranscriptRecords(
  pathLabel: string,
  records: JsonRecord[],
  meta?: { fileBytes?: number; configuredSkills?: string[]; model?: string },
): TranscriptAudit | null {
  const sessionRecord = records.find((entry) => entry.type === "session");
  const sessionId =
    sessionRecord && typeof sessionRecord.id === "string" ? sessionRecord.id : undefined;
  const messages = records.filter((entry) => entry.type === "message");
  if (messages.length === 0) {
    return null;
  }

  const assistantTexts: TranscriptAssistantText[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  const toolResults: TranscriptToolResult[] = [];
  const readPaths: string[] = [];
  const delegationCounts = new Map<string, number>();
  const execFailureCounts = new Map<string, number>();
  let userTurns = 0;
  let assistantTurns = 0;

  for (const record of messages) {
    const line =
      typeof record.__line === "number" && Number.isFinite(record.__line) ? record.__line : 0;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    const message = record.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const typedMessage = message as Record<string, unknown>;
    const role = typedMessage.role;
    if (role === "user") {
      userTurns += 1;
      continue;
    }
    if (role === "assistant") {
      assistantTurns += 1;
      const text = getTextBlocks(typedMessage.content).join("\n").trim();
      if (text) {
        assistantTexts.push({ line, timestamp, text });
      }
      for (const call of getToolCalls(typedMessage.content)) {
        toolCalls.push({ ...call, line, timestamp });
        if (call.name === "read") {
          const readPath = call.arguments?.path;
          if (typeof readPath === "string" && readPath.trim()) {
            readPaths.push(readPath.trim());
          }
        }
        if (DELEGATION_TOOL_NAMES.has(call.name)) {
          delegationCounts.set(call.name, (delegationCounts.get(call.name) ?? 0) + 1);
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = typeof typedMessage.toolCallId === "string" ? typedMessage.toolCallId : "";
      if (!toolCallId) {
        continue;
      }
      toolResults.push({
        toolCallId,
        toolName: typeof typedMessage.toolName === "string" ? typedMessage.toolName : undefined,
        line,
        timestamp,
        exitCode: parseExitCode(typedMessage),
        text: getToolResultText(typedMessage),
      });
      if (typedMessage.toolName === "exec") {
        const text = getToolResultText(typedMessage);
        const exitCode = parseExitCode(typedMessage);
        if (typeof exitCode === "number" && exitCode !== 0) {
          const key = text
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(" | ");
          if (key) {
            execFailureCounts.set(key, (execFailureCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }

  const toolResultById = new Map(toolResults.map((result) => [result.toolCallId, result]));
  const execCalls = toolCalls.filter((call) => call.name === "exec");
  const skillReads = Array.from(
    new Set(
      toolCalls
        .filter((call) => call.name === "read")
        .map((call) => call.arguments?.path)
        .filter(
          (value): value is string => typeof value === "string" && value.endsWith("/SKILL.md"),
        )
        .map((value) => inferSkillName(value)),
    ),
  );
  const configuredSkills = meta?.configuredSkills?.slice().toSorted() ?? [];
  const retrievalReads = Array.from(
    new Set(
      readPaths.filter((readPath) =>
        RETRIEVAL_PATH_RULES.some((rule) => rule.re.test(readPath.replace(/\\/g, "/"))),
      ),
    ),
  ).toSorted();
  const cappedReadMarkers = records.reduce((count, entry) => {
    const message = entry.message;
    if (!message || typeof message !== "object") {
      return count;
    }
    const text = getToolResultText(message as Record<string, unknown>);
    return count + (text.includes("[Read output capped at") ? 1 : 0);
  }, 0);
  const repeatedExecFailureSamples = [...execFailureCounts.entries()]
    .filter(([, count]) => count > 1)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([sample]) => sample);
  const repeatedExecFailures = [...execFailureCounts.values()].filter((count) => count > 1).length;

  const firstAnalysisLine = assistantTexts[0]?.line;
  const preflightSatisfied = new Set<PreflightCheckKey>();
  for (const call of execCalls) {
    if (firstAnalysisLine && call.line >= firstAnalysisLine) {
      break;
    }
    const command = call.arguments?.command;
    if (typeof command !== "string") {
      continue;
    }
    for (const key of inspectCommandForPreflight(command)) {
      preflightSatisfied.add(key);
    }
  }

  const firstSuccessfulExec = execCalls
    .map((call) => ({ call, result: toolResultById.get(call.id) }))
    .find(({ result }) => result?.exitCode === 0);
  const firstFailedExec = execCalls
    .map((call) => ({ call, result: toolResultById.get(call.id) }))
    .find(({ result }) => typeof result?.exitCode === "number" && result.exitCode !== 0);

  const evidenceLine = firstSuccessfulExec?.result?.line;
  const speculationBeforeEvidence = assistantTexts.some((entry) => {
    if (evidenceLine && entry.line >= evidenceLine) {
      return false;
    }
    return SPECULATION_RE.test(entry.text);
  });

  const blockedReply = (() => {
    if (!firstFailedExec?.result) {
      return undefined;
    }
    return assistantTexts.find((entry) => {
      if (entry.line <= firstFailedExec.result.line) {
        return false;
      }
      if (evidenceLine && entry.line >= evidenceLine) {
        return false;
      }
      return true;
    });
  })();

  const blockedReplyHasExactError =
    blockedReply && firstFailedExec?.result
      ? hasExactErrorReference(blockedReply.text, firstFailedExec.result.text)
      : false;
  const blockedReplyHasNextChecks = blockedReply ? NEXT_CHECKS_RE.test(blockedReply.text) : false;
  const blockedReplyHasSpeculation = blockedReply ? SPECULATION_RE.test(blockedReply.text) : false;
  const blockedReplyIsLong = blockedReply ? countNonEmptyLines(blockedReply.text) > 12 : false;

  return {
    path: pathLabel,
    sessionId,
    model: meta?.model,
    userTurns,
    assistantTurns,
    records: records.length,
    fileBytes: meta?.fileBytes,
    toolCalls: toolCalls.length,
    execCalls: execCalls.length,
    execFailures: execCalls.filter((call) => {
      const result = toolResultById.get(call.id);
      return typeof result?.exitCode === "number" && result.exitCode !== 0;
    }).length,
    skillReads,
    configuredSkills,
    retrieval: {
      score: retrievalReads.length,
      reads: retrievalReads,
      usedKnowledgeIndex: retrievalReads.some((entry) => /knowledge-index\.md$/i.test(entry)),
      usedRunbookMap: retrievalReads.some((entry) => /runbook-map\.md$/i.test(entry)),
      usedRepoRootModel: retrievalReads.some((entry) => /repo-root-model\.md$/i.test(entry)),
      usedIncidentDossier: retrievalReads.some((entry) => /incident-dossier/i.test(entry)),
      usedNotionPostmortemIndex: retrievalReads.some((entry) =>
        /notion-postmortem-index\.md$/i.test(entry),
      ),
    },
    delegation: {
      score: [...delegationCounts.values()].reduce((sum, count) => sum + count, 0),
      toolCounts: Object.fromEntries(
        [...delegationCounts.entries()].toSorted((a, b) => a[0].localeCompare(b[0])),
      ),
    },
    bloat: {
      largeTranscript: (meta?.fileBytes ?? 0) >= LARGE_TRANSCRIPT_BYTES,
      hugeTranscript: (meta?.fileBytes ?? 0) >= HUGE_TRANSCRIPT_BYTES,
      cappedReadMarkers,
      repeatedExecFailures,
      repeatedExecFailureSamples,
    },
    preflight: {
      score: preflightSatisfied.size,
      satisfied: [...preflightSatisfied].toSorted(),
      missing: listMissingChecks(preflightSatisfied),
      firstAnalysisLine,
    },
    discussion: {
      speculationBeforeEvidence,
      firstSuccessfulExecLine: firstSuccessfulExec?.result?.line,
      firstFailedExecLine: firstFailedExec?.result?.line,
      blockedReplyLine: blockedReply?.line,
      blockedReplyHasExactError,
      blockedReplyHasNextChecks,
      blockedReplyHasSpeculation,
      blockedReplyIsLong,
    },
  };
}

export function parseTranscriptJsonl(raw: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as JsonRecord;
    parsed.__line = index + 1;
    records.push(parsed);
  }
  return records;
}

async function walkForJsonlFiles(inputPath: string, out: string[]): Promise<void> {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    if (inputPath.endsWith(".jsonl")) {
      out.push(inputPath);
    }
    return;
  }
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      await walkForJsonlFiles(child, out);
      continue;
    }
    if (entry.isFile() && child.endsWith(".jsonl")) {
      out.push(child);
    }
  }
}

async function collectTranscriptFiles(inputs: string[]): Promise<string[]> {
  const seeds = inputs.length > 0 ? inputs : [path.join(os.homedir(), ".openclaw", "agents")];
  const files: string[] = [];
  for (const input of seeds) {
    const resolved = path.resolve(expandHome(input));
    await walkForJsonlFiles(resolved, files).catch(() => {});
  }
  return files.filter((file) => path.basename(file) !== "config-audit.jsonl").toSorted();
}

async function loadSessionMetadataByDir(
  transcriptFiles: string[],
): Promise<Map<string, SessionMetadata>> {
  const byDir = new Map<string, SessionMetadata>();
  const dirs = new Set(transcriptFiles.map((file) => path.dirname(file)));
  for (const dir of dirs) {
    const sessionsPath = path.join(dir, "sessions.json");
    try {
      const parsed = JSON.parse(await fs.readFile(sessionsPath, "utf8")) as Record<string, unknown>;
      for (const value of Object.values(parsed)) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const record = value as Record<string, unknown>;
        const sessionFile = typeof record.sessionFile === "string" ? record.sessionFile : "";
        if (!sessionFile) {
          continue;
        }
        const basename = path.basename(sessionFile);
        const skillsSnapshot =
          record.skillsSnapshot && typeof record.skillsSnapshot === "object"
            ? (record.skillsSnapshot as Record<string, unknown>)
            : undefined;
        const configuredSkillsRaw = skillsSnapshot?.skills;
        const configuredSkills = Array.isArray(configuredSkillsRaw)
          ? configuredSkillsRaw
              .map((entry) =>
                entry &&
                typeof entry === "object" &&
                typeof (entry as { name?: unknown }).name === "string"
                  ? (entry as { name: string }).name
                  : null,
              )
              .filter((value): value is string => Boolean(value))
          : [];
        const model = typeof record.model === "string" ? record.model : undefined;
        byDir.set(path.join(dir, basename), { configuredSkills, model });
      }
    } catch {
      continue;
    }
  }
  return byDir;
}

export async function auditTranscriptPaths(pathsToScan: string[]): Promise<TranscriptAuditSummary> {
  const transcriptFiles = await collectTranscriptFiles(pathsToScan);
  const metaByFile = await loadSessionMetadataByDir(transcriptFiles);
  const sessions: TranscriptAudit[] = [];

  for (const file of transcriptFiles) {
    const raw = await fs.readFile(file, "utf8");
    const records = parseTranscriptJsonl(raw);
    const stat = await fs.stat(file);
    const meta = metaByFile.get(file);
    const audit = analyzeTranscriptRecords(file, records, {
      fileBytes: stat.size,
      configuredSkills: meta?.configuredSkills,
      model: meta?.model,
    });
    if (audit) {
      sessions.push(audit);
    }
  }

  const skillCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const skill of session.skillReads) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }

  const recommendations: string[] = [];
  const sessionsWithSkills = sessions.filter((entry) => entry.skillReads.length > 0).length;
  const sessionsWithConfiguredSkills = sessions.filter(
    (entry) => entry.configuredSkills.length > 0,
  ).length;
  const sessionsWithPreflight = sessions.filter((entry) => entry.preflight.score > 0).length;
  const sessionsWithStrongPreflight = sessions.filter((entry) => entry.preflight.score >= 3).length;
  const sessionsWithSpeculationBeforeEvidence = sessions.filter(
    (entry) => entry.discussion.speculationBeforeEvidence,
  ).length;
  const sessionsWithBlockedReplies = sessions.filter(
    (entry) => typeof entry.discussion.blockedReplyLine === "number",
  ).length;
  const sessionsWithRetrieval = sessions.filter((entry) => entry.retrieval.score > 0).length;
  const sessionsWithDelegation = sessions.filter((entry) => entry.delegation.score > 0).length;
  const sessionsWithLargeTranscripts = sessions.filter(
    (entry) => entry.bloat.largeTranscript,
  ).length;
  const sessionsWithHugeTranscripts = sessions.filter((entry) => entry.bloat.hugeTranscript).length;

  if (sessionsWithConfiguredSkills > 0 && sessionsWithPreflight < sessionsWithConfiguredSkills) {
    recommendations.push(
      "Harden skill compliance: require binary/PATH, AWS identity, kubectl context, and namespace preflight before diagnosis.",
    );
  }
  if (sessionsWithSpeculationBeforeEvidence > 0) {
    recommendations.push(
      "Block hypotheses until at least one successful live check lands; failed exec alone should switch the agent into blocked-investigation mode.",
    );
  }
  if (
    sessions.some(
      (entry) =>
        entry.discussion.blockedReplyLine &&
        (!entry.discussion.blockedReplyHasExactError ||
          !entry.discussion.blockedReplyHasNextChecks),
    )
  ) {
    recommendations.push(
      "Standardize blocked replies: include exact failing command/error and no more than 3 next checks.",
    );
  }
  if (sessions.some((entry) => entry.discussion.blockedReplyHasSpeculation)) {
    recommendations.push(
      "Remove speculation from blocked replies; access/runtime failures should not produce ranked causes.",
    );
  }
  if (sessions.some((entry) => entry.discussion.blockedReplyIsLong)) {
    recommendations.push(
      "Shorten blocked investigation messages; use compact status plus commands instead of long prose walls.",
    );
  }
  if (sessionsWithConfiguredSkills > 0 && sessionsWithRetrieval === 0) {
    recommendations.push(
      "Force skill retrieval before repo spelunking: require knowledge-index/runbook-map/repo-root-model or dossier reads in evidence-driven incident sessions.",
    );
  }
  if (sessionsWithDelegation === 0 && sessionsWithConfiguredSkills > 0) {
    recommendations.push(
      "Use specialist delegation more often: route k8s, observability, and release investigations to dedicated subagents instead of keeping all triage in the primary SRE session.",
    );
  }
  if (sessionsWithLargeTranscripts > 0) {
    recommendations.push(
      "Control transcript bloat: summarize repeated tool output, cap repeated failures, and stop re-running the same blocked checks.",
    );
  }

  return {
    scannedPaths: pathsToScan.length > 0 ? pathsToScan : [path.join("~", ".openclaw", "agents")],
    transcriptCount: sessions.length,
    aggregate: {
      userTurns: sessions.reduce((sum, entry) => sum + entry.userTurns, 0),
      assistantTurns: sessions.reduce((sum, entry) => sum + entry.assistantTurns, 0),
      execCalls: sessions.reduce((sum, entry) => sum + entry.execCalls, 0),
      execFailures: sessions.reduce((sum, entry) => sum + entry.execFailures, 0),
      sessionsWithSkills,
      sessionsWithConfiguredSkills,
      sessionsWithVisibleSkillReads: sessionsWithSkills,
      sessionsWithSpeculationBeforeEvidence,
      sessionsWithBlockedReplies,
      sessionsWithPreflight,
      sessionsWithStrongPreflight,
      sessionsWithRetrieval,
      sessionsWithDelegation,
      sessionsWithLargeTranscripts,
      sessionsWithHugeTranscripts,
    },
    skills: [...skillCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    recommendations,
    sessions,
  };
}

function formatSummary(summary: TranscriptAuditSummary): string {
  const lines: string[] = [];
  lines.push("Session Transcript Audit");
  lines.push("");
  lines.push(`Scanned paths: ${summary.scannedPaths.join(", ")}`);
  lines.push(`Transcripts analyzed: ${summary.transcriptCount}`);
  lines.push(`User turns: ${summary.aggregate.userTurns}`);
  lines.push(`Assistant turns: ${summary.aggregate.assistantTurns}`);
  lines.push(`Exec calls: ${summary.aggregate.execCalls}`);
  lines.push(`Exec failures: ${summary.aggregate.execFailures}`);
  lines.push(`Sessions with configured skills: ${summary.aggregate.sessionsWithConfiguredSkills}`);
  lines.push(
    `Sessions with visible skill reads: ${summary.aggregate.sessionsWithVisibleSkillReads}`,
  );
  lines.push(`Sessions with any preflight: ${summary.aggregate.sessionsWithPreflight}`);
  lines.push(`Sessions with strong preflight: ${summary.aggregate.sessionsWithStrongPreflight}`);
  lines.push(`Sessions with retrieval reads: ${summary.aggregate.sessionsWithRetrieval}`);
  lines.push(`Sessions with delegation: ${summary.aggregate.sessionsWithDelegation}`);
  lines.push(
    `Sessions with speculation before evidence: ${summary.aggregate.sessionsWithSpeculationBeforeEvidence}`,
  );
  lines.push(`Sessions with blocked replies: ${summary.aggregate.sessionsWithBlockedReplies}`);
  lines.push(`Sessions with large transcripts: ${summary.aggregate.sessionsWithLargeTranscripts}`);
  lines.push(`Sessions with huge transcripts: ${summary.aggregate.sessionsWithHugeTranscripts}`);
  lines.push("");
  lines.push(
    `Skill usage: ${
      summary.skills.length > 0
        ? summary.skills.map((entry) => `${entry.name} (${entry.count})`).join(", ")
        : "none"
    }`,
  );
  lines.push("");
  if (summary.recommendations.length > 0) {
    lines.push("Recommendations:");
    for (const recommendation of summary.recommendations) {
      lines.push(`- ${recommendation}`);
    }
    lines.push("");
  }
  if (summary.sessions.length > 0) {
    lines.push("Per session:");
    for (const session of summary.sessions) {
      lines.push(`- ${session.path}`);
      lines.push(
        `  configured_skills=${session.configuredSkills.join(",") || "none"} visible_skill_reads=${session.skillReads.join(",") || "none"} preflight=${session.preflight.score}/4 retrieval=${session.retrieval.score} delegation=${session.delegation.score}`,
      );
      lines.push(
        `  blocked_reply=${session.discussion.blockedReplyLine ? "yes" : "no"} exact_error=${session.discussion.blockedReplyHasExactError ? "yes" : "no"} next_checks=${session.discussion.blockedReplyHasNextChecks ? "yes" : "no"}`,
      );
      lines.push(
        `  large=${session.bloat.largeTranscript ? "yes" : "no"} huge=${session.bloat.hugeTranscript ? "yes" : "no"} repeated_failures=${session.bloat.repeatedExecFailures} capped_reads=${session.bloat.cappedReadMarkers}`,
      );
    }
  }
  return lines.join("\n");
}

type CliOptions = {
  json: boolean;
  help: boolean;
  paths: string[];
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, help: false, paths: [] };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    options.paths.push(arg);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/audit-session-transcripts.ts [--json] [file-or-dir ...]

Audits OpenClaw session JSONL transcripts for:
- skill loads
- preflight compliance
- speculation before live evidence
- blocked investigation reply quality

Defaults to: ~/.openclaw/agents`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const summary = await auditTranscriptPaths(options.paths);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(formatSummary(summary));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`audit-session-transcripts: ${String(err)}`);
    process.exitCode = 1;
  });
}
