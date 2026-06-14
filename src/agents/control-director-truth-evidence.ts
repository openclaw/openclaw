import { createHash } from "node:crypto";
import fs from "node:fs";
import type { SessionEntry } from "../config/sessions/types.js";
import type {
  ControlDirectorClaimEvidence,
  ControlDirectorClaimEvidenceType,
} from "./control-director-contract.js";

export const MAX_CONTROL_DIRECTOR_TRUTH_EVIDENCE = 50;

const MAX_SESSION_TAIL_BYTES = 2_000_000;
const MAX_EVIDENCE_SUMMARY_CHARS = 500;

type UnknownRecord = Record<string, unknown>;

export type ControlDirectorTruthEvidenceRecord = UnknownRecord;

export type BuildControlDirectorTruthEvidenceParams = {
  records?: readonly unknown[] | undefined;
  runId?: string | undefined;
  implementationSha?: string | undefined;
  extraEvidence?: readonly ControlDirectorClaimEvidence[] | undefined;
};

export type LoadControlDirectorTruthEvidenceParams = BuildControlDirectorTruthEvidenceParams & {
  sessionEntry?: Pick<SessionEntry, "sessionFile"> | null | undefined;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_EVIDENCE_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_EVIDENCE_SUMMARY_CHARS - 20)}… [truncated]`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function toStringField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function maybePushText(out: string[], value: unknown, depth = 0): void {
  if (depth > 4 || value === undefined || value === null) {
    return;
  }
  const direct = toStringField(value);
  if (direct) {
    out.push(direct);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      maybePushText(out, item, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of [
    "text",
    "content",
    "toolOutput",
    "output",
    "stdout",
    "stderr",
    "summary",
    "tail",
    "message",
  ]) {
    maybePushText(out, value[key], depth + 1);
  }
}

function collectRecordText(record: UnknownRecord): string {
  const parts: string[] = [];
  maybePushText(parts, record);
  if (isRecord(record.details)) {
    maybePushText(parts, record.details);
  }
  return parts.join("\n");
}

function getNestedRecord(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function firstString(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const direct = toStringField(record[key]);
    if (direct) {
      return direct;
    }
    const details = getNestedRecord(record, "details");
    const fromDetails = details ? toStringField(details[key]) : undefined;
    if (fromDetails) {
      return fromDetails;
    }
  }
  return undefined;
}

function extractExitCode(record: UnknownRecord): number | undefined {
  for (const value of [record.exitCode, getNestedRecord(record, "details")?.exitCode]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function extractToolName(record: UnknownRecord): string | undefined {
  return firstString(record, ["toolName", "name", "tool", "toolId"]);
}

function extractCommand(record: UnknownRecord): string | undefined {
  const direct = firstString(record, ["command", "cmd"]);
  if (direct) {
    return direct;
  }
  const details = getNestedRecord(record, "details");
  if (details && Array.isArray(details.args)) {
    return details.args
      .map((value) => toStringField(value))
      .filter(Boolean)
      .join(" ");
  }
  return undefined;
}

function isControlDirectorTruthEvidenceCarrier(record: UnknownRecord): boolean {
  const role = toStringField(record.role)?.toLowerCase();
  if (role === "assistant" || role === "user" || role === "system") {
    return false;
  }
  return (
    role === "toolresult" ||
    role === "tool" ||
    extractToolName(record) !== undefined ||
    extractExitCode(record) !== undefined ||
    isRecord(record.details) ||
    record.toolOutput !== undefined
  );
}

function parseJsonRecordsFromText(text: string): UnknownRecord[] {
  const records: UnknownRecord[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Tool output is often free text. Ignore parse failures.
    }
  }
  for (const line of text.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return records;
}

function extractGithubRunMetadata(
  record: UnknownRecord,
  text: string,
): { conclusion?: string; headSha?: string; id?: string } {
  const sources = [
    record,
    getNestedRecord(record, "details"),
    ...parseJsonRecordsFromText(text),
  ].filter((candidate): candidate is UnknownRecord => Boolean(candidate));
  let conclusion: string | undefined;
  let headSha: string | undefined;
  let id: string | undefined;
  for (const source of sources) {
    conclusion ??= firstString(source, ["conclusion", "workflowConclusion"]);
    headSha ??= firstString(source, ["headSha", "head_sha", "sha"]);
    id ??= firstString(source, ["databaseId", "runId", "run_id", "id", "htmlUrl", "url"]);
  }
  conclusion ??= text.match(/\bconclusion["'\s:=]+([a-z_ -]+)/iu)?.[1]?.trim();
  headSha ??= text.match(/\b(?:headSha|head_sha|sha)["'\s:=]+([a-f0-9]{7,40})\b/iu)?.[1];
  id ??= text.match(/\b(?:run|databaseId|runId)["'\s:=#]+([0-9]{5,})\b/iu)?.[1];
  return { conclusion, headSha, id };
}

function hasSuccessfulUiSmoke(text: string): boolean {
  if (/control-ui-control-director-no-response-smoke:\s*ok/iu.test(text)) {
    return true;
  }
  if (
    /\bui:smoke:control-director-no-response\b/iu.test(text) &&
    /\b(ok|passed|success)\b/iu.test(text)
  ) {
    return true;
  }
  return parseJsonRecordsFromText(text).some(
    (record) =>
      record.ok === true ||
      (record.unsupportedCompleteDelivered === false &&
        (record.webVisibleStatus === true || record.mobileVisibleStatus === true)),
  );
}

function extractRepoTouchedFiles(text: string): string[] {
  const files = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/u);
    if (diffMatch?.[1]) {
      files.add(diffMatch[1]);
    }
    if (diffMatch?.[2]) {
      files.add(diffMatch[2]);
    }
    const statusMatch = line.match(/^[ MADRCU?!]{1,2}\s+(.+)$/u);
    if (statusMatch?.[1] && /[/.-]/u.test(statusMatch[1])) {
      files.add(statusMatch[1]);
    }
    const fileMatch = line.match(/\b(?:src|test|scripts|ui|docs|extensions|packages)\/[\w./-]+/u);
    if (fileMatch?.[0]) {
      files.add(fileMatch[0]);
    }
  }
  return [...files].toSorted();
}

function hasSourceCitationEvidence(toolName: string | undefined, text: string): boolean {
  if (/https?:\/\/[^\s)]+/iu.test(text)) {
    return true;
  }
  return /\b(web_fetch|web\.|browser|search|open|source)\b/iu.test(toolName ?? "");
}

function makeEvidence(params: {
  type: ControlDirectorClaimEvidenceType;
  source: string;
  summary: string;
  exitCode?: number | undefined;
  sha?: string | undefined;
  idSeed?: string | undefined;
}): ControlDirectorClaimEvidence {
  const summary = trimSummary(params.summary);
  const idSeed =
    params.idSeed ?? `${params.type}\0${params.source}\0${summary}\0${params.sha ?? ""}`;
  return {
    type: params.type,
    id: `${params.type}:${shortHash(idSeed)}`,
    source: params.source,
    summary,
    status: "passed",
    ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
    ...(params.sha ? { sha: params.sha } : {}),
  };
}

function evidenceFromRecord(params: {
  record: UnknownRecord;
  implementationSha?: string | undefined;
}): ControlDirectorClaimEvidence[] {
  const { record, implementationSha } = params;
  if (!isControlDirectorTruthEvidenceCarrier(record)) {
    return [];
  }

  const exitCode = extractExitCode(record);
  const command = extractCommand(record);
  const toolName = extractToolName(record);
  const text = [command, toolName, collectRecordText(record)].filter(Boolean).join("\n");
  const source = command ?? toolName ?? "tool-result";
  const evidence: ControlDirectorClaimEvidence[] = [];
  const commandSucceeded = exitCode === 0;

  if (commandSucceeded) {
    evidence.push(
      makeEvidence({
        type: "command",
        source,
        summary: command ? `${command}\n${text}` : text,
        exitCode,
      }),
    );
  }

  const githubRunCandidate =
    /\bgh\s+run\s+view\b/iu.test(text) ||
    /\bgithub(?: actions?)?\b/iu.test(text) ||
    /\b(headSha|head_sha|conclusion)\b/iu.test(text);
  if (commandSucceeded && githubRunCandidate) {
    const metadata = extractGithubRunMetadata(record, text);
    const conclusion = metadata.conclusion?.toLowerCase();
    const matchesSha =
      !implementationSha ||
      (metadata.headSha !== undefined && metadata.headSha === implementationSha);
    if (conclusion === "success" && matchesSha) {
      evidence.push(
        makeEvidence({
          type: "github_run",
          source: "github-actions",
          summary: `GitHub run ${metadata.id ?? "unknown"} succeeded for ${metadata.headSha ?? "unknown SHA"}.`,
          exitCode,
          sha: metadata.headSha,
          idSeed: metadata.id,
        }),
      );
    }
  }

  if (commandSucceeded && hasSuccessfulUiSmoke(text)) {
    evidence.push(
      makeEvidence({
        type: "ui_smoke",
        source: "control-ui-smoke",
        summary: text,
        exitCode,
      }),
    );
  }

  const repoTouchedFiles = extractRepoTouchedFiles(text);
  const repoCommand =
    /\bgit\s+(?:diff|show|status|log)\b/iu.test(text) || /diff --git/iu.test(text);
  if (commandSucceeded && repoCommand && repoTouchedFiles.length > 0) {
    evidence.push(
      makeEvidence({
        type: "repo_change",
        source: "git",
        summary: `Repo change evidence touched: ${repoTouchedFiles.slice(0, 20).join(", ")}`,
        exitCode,
      }),
    );
  }

  const sourceSucceeded = exitCode === undefined ? record.isError !== true : commandSucceeded;
  if (sourceSucceeded && hasSourceCitationEvidence(toolName, text)) {
    evidence.push(
      makeEvidence({
        type: "source_citation",
        source: toolName ?? "source",
        summary: text,
        ...(exitCode !== undefined ? { exitCode } : {}),
      }),
    );
  }

  return evidence;
}

function dedupeAndCapEvidence(
  evidence: readonly ControlDirectorClaimEvidence[],
): ControlDirectorClaimEvidence[] {
  const seen = new Set<string>();
  const deduped: ControlDirectorClaimEvidence[] = [];
  for (const entry of evidence) {
    const key = `${entry.type}:${entry.id}:${entry.sha ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped.slice(-MAX_CONTROL_DIRECTOR_TRUTH_EVIDENCE);
}

export function buildControlDirectorTruthEvidenceFromRecords(
  params: BuildControlDirectorTruthEvidenceParams,
): ControlDirectorClaimEvidence[] {
  const records = params.records ?? [];
  const extracted: ControlDirectorClaimEvidence[] = [];
  for (const value of records) {
    if (!isRecord(value)) {
      continue;
    }
    extracted.push(
      ...evidenceFromRecord({
        record: value,
        implementationSha: params.implementationSha,
      }),
    );
  }
  return dedupeAndCapEvidence([...(params.extraEvidence ?? []), ...extracted]);
}

function readSessionFileRecords(sessionFile: string | undefined): UnknownRecord[] {
  if (!sessionFile) {
    return [];
  }
  try {
    const stats = fs.statSync(sessionFile);
    const readBytes = Math.min(stats.size, MAX_SESSION_TAIL_BYTES);
    const fd = fs.openSync(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, stats.size - readBytes);
      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/u);
      // If the tail started in the middle of a JSONL record, skip the first partial line.
      const candidateLines = stats.size > readBytes ? lines.slice(1) : lines;
      const records: UnknownRecord[] = [];
      for (const line of candidateLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed)) {
            records.push(parsed);
          }
        } catch {
          // Ignore malformed or partial JSONL rows.
        }
      }
      return records;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function loadControlDirectorTruthEvidence(
  params: LoadControlDirectorTruthEvidenceParams,
): ControlDirectorClaimEvidence[] {
  return buildControlDirectorTruthEvidenceFromRecords({
    records: [
      ...(params.records ?? []),
      ...readSessionFileRecords(params.sessionEntry?.sessionFile),
    ],
    runId: params.runId,
    implementationSha: params.implementationSha,
    extraEvidence: params.extraEvidence,
  });
}
