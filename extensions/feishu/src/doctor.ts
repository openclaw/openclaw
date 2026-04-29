import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import {
  loadSessionStore,
  resolveDefaultAgentId,
  resolveStorePath,
  updateSessionStore,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const FEISHU_STATE_DIR = "feishu";
const BACKUP_PREFIX = "feishu-state-repair";
const BLANK_USER_MESSAGE_REPAIR_THRESHOLD = 3;
const SESSION_FILE_INSPECTION_MAX_BYTES = 16 * 1024 * 1024;

type FeishuDoctorFinding =
  | {
      kind: "corrupt-state-json";
      path: string;
    }
  | {
      kind: "missing-session-transcript";
      sessionKey: string;
      storePath: string;
    }
  | {
      kind: "invalid-session-transcript";
      sessionKey: string;
      storePath: string;
      path: string;
      reason: string;
    }
  | {
      kind: "blank-user-message-run";
      sessionKey: string;
      storePath: string;
      path: string;
      count: number;
    };

type FeishuSessionTarget = {
  agentId: string;
  storePath: string;
};

type FeishuSessionEntry = {
  sessionId?: unknown;
  sessionFile?: unknown;
};

export type FeishuDoctorInspection = {
  stateDir: string;
  feishuStateDir: string;
  findings: FeishuDoctorFinding[];
  sessionEntries: Array<{
    key: string;
    storePath: string;
    agentId: string;
    entry: FeishuSessionEntry;
  }>;
};

export type FeishuDoctorRepairReport = {
  backupDir: string;
  rebuiltStateDir: boolean;
  removedSessionEntries: number;
  touchedSessionStores: number;
  archivedSessionArtifacts: number;
  warnings: string[];
};

function timestampForPath(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function existsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatDisplayPath(filePath: string): string {
  const home = os.homedir();
  const resolved = path.resolve(filePath);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
}

function formatFinding(finding: FeishuDoctorFinding): string {
  switch (finding.kind) {
    case "corrupt-state-json":
      return `- Feishu local JSON state is corrupt: ${formatDisplayPath(finding.path)}`;
    case "missing-session-transcript":
      return `- Feishu session ${finding.sessionKey} points to a missing transcript in ${formatDisplayPath(
        finding.storePath,
      )}`;
    case "invalid-session-transcript":
      return `- Feishu session ${finding.sessionKey} has an invalid transcript (${finding.reason}): ${formatDisplayPath(
        finding.path,
      )}`;
    case "blank-user-message-run":
      return `- Feishu session ${finding.sessionKey} contains ${finding.count} blank user messages: ${formatDisplayPath(
        finding.path,
      )}`;
  }
}

export function isFeishuSessionStoreKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return /^agent:[^:]+:feishu(?::|$)/.test(normalized) || /^feishu(?::|$)/.test(normalized);
}

function collectConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  ids.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
  for (const agent of cfg.agents?.list ?? []) {
    if (typeof agent.id === "string" && agent.id.trim()) {
      ids.add(normalizeAgentId(agent.id));
    }
  }
  return [...ids].toSorted();
}

function collectFeishuSessionTargets(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): FeishuSessionTarget[] {
  const byStorePath = new Map<string, FeishuSessionTarget>();
  const addTarget = (target: FeishuSessionTarget) => {
    byStorePath.set(path.resolve(target.storePath), {
      ...target,
      storePath: path.resolve(target.storePath),
    });
  };

  for (const agentId of collectConfiguredAgentIds(params.cfg)) {
    addTarget({
      agentId,
      storePath: resolveStorePath(params.cfg.session?.store, { agentId, env: params.env }),
    });
  }

  const agentsDir = path.join(params.stateDir, "agents");
  for (const agentDir of safeReadDir(agentsDir)) {
    if (!agentDir.isDirectory()) {
      continue;
    }
    const agentId = normalizeAgentId(agentDir.name);
    const storePath = path.join(agentsDir, agentDir.name, "sessions", "sessions.json");
    if (existsFile(storePath)) {
      addTarget({ agentId, storePath });
    }
  }

  return [...byStorePath.values()].toSorted((left, right) =>
    left.storePath.localeCompare(right.storePath),
  );
}

function collectJsonFiles(rootDir: string, limit = 200): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= limit) {
      return;
    }
    for (const entry of safeReadDir(dir).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
      if (files.length >= limit) {
        return;
      }
    }
  };
  if (existsDir(rootDir)) {
    visit(rootDir);
  }
  return files;
}

function collectCorruptFeishuStateJsonFindings(feishuStateDir: string): FeishuDoctorFinding[] {
  const findings: FeishuDoctorFinding[] = [];
  for (const filePath of collectJsonFiles(feishuStateDir)) {
    try {
      JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      findings.push({ kind: "corrupt-state-json", path: filePath });
    }
  }
  return findings;
}

function resolveSessionTranscriptCandidates(params: {
  storePath: string;
  entry: FeishuSessionEntry;
}): string[] {
  const candidates = new Set<string>();
  const sessionsDir = path.dirname(params.storePath);
  const addSafeCandidate = (candidate: string) => {
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(sessionsDir, candidate);
    if (resolved === sessionsDir || !isPathWithinRoot(resolved, sessionsDir)) {
      return;
    }
    candidates.add(resolved);
  };

  if (typeof params.entry.sessionFile === "string" && params.entry.sessionFile.trim()) {
    addSafeCandidate(params.entry.sessionFile.trim());
  }
  if (
    typeof params.entry.sessionId === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(params.entry.sessionId)
  ) {
    addSafeCandidate(`${params.entry.sessionId}.jsonl`);
  }

  return [...candidates].toSorted();
}

function isSessionHeader(value: unknown): boolean {
  return isRecord(value) && value.type === "session" && typeof value.id === "string";
}

function isBlankUserMessage(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) {
    return false;
  }
  if (value.message.role !== "user") {
    return false;
  }
  const content = value.message.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  return Array.isArray(content) && content.length === 0;
}

function inspectSessionTranscript(params: {
  sessionKey: string;
  storePath: string;
  transcriptPath: string;
}): FeishuDoctorFinding | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(params.transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return {
      kind: "invalid-session-transcript",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      reason: "not a file",
    };
  }
  if (stat.size > SESSION_FILE_INSPECTION_MAX_BYTES) {
    return null;
  }

  let raw = "";
  try {
    raw = fs.readFileSync(params.transcriptPath, "utf-8");
  } catch {
    return {
      kind: "invalid-session-transcript",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      reason: "unreadable",
    };
  }

  const entries: unknown[] = [];
  let malformedLines = 0;
  let blankUserMessages = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      if (isBlankUserMessage(entry)) {
        blankUserMessages += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  if (entries.length === 0) {
    return {
      kind: "invalid-session-transcript",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      reason: "empty transcript",
    };
  }
  if (!isSessionHeader(entries[0])) {
    return {
      kind: "invalid-session-transcript",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      reason: "invalid session header",
    };
  }
  if (malformedLines > 0) {
    return {
      kind: "invalid-session-transcript",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      reason: `${malformedLines} malformed JSONL line(s)`,
    };
  }
  if (blankUserMessages >= BLANK_USER_MESSAGE_REPAIR_THRESHOLD) {
    return {
      kind: "blank-user-message-run",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      path: params.transcriptPath,
      count: blankUserMessages,
    };
  }
  return null;
}

function collectFeishuSessionFindings(params: {
  sessionKey: string;
  storePath: string;
  entry: FeishuSessionEntry;
}): FeishuDoctorFinding[] {
  const transcriptCandidates = resolveSessionTranscriptCandidates(params);
  const existing = transcriptCandidates.filter(existsFile);
  if (transcriptCandidates.length > 0 && existing.length === 0) {
    return [
      {
        kind: "missing-session-transcript",
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
    ];
  }

  const findings: FeishuDoctorFinding[] = [];
  for (const transcriptPath of existing) {
    const finding = inspectSessionTranscript({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      transcriptPath,
    });
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

export function inspectFeishuDoctorState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): FeishuDoctorInspection {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env, os.homedir);
  const feishuStateDir = path.join(stateDir, FEISHU_STATE_DIR);
  const findings: FeishuDoctorFinding[] = collectCorruptFeishuStateJsonFindings(feishuStateDir);
  const sessionEntries: FeishuDoctorInspection["sessionEntries"] = [];

  for (const target of collectFeishuSessionTargets({ cfg: params.cfg, env, stateDir })) {
    const store = loadSessionStore(target.storePath, { skipCache: true });
    for (const [key, entry] of Object.entries(store).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isFeishuSessionStoreKey(key)) {
        continue;
      }
      sessionEntries.push({
        key,
        storePath: target.storePath,
        agentId: target.agentId,
        entry,
      });
      findings.push(
        ...collectFeishuSessionFindings({
          sessionKey: key,
          storePath: target.storePath,
          entry,
        }),
      );
    }
  }

  return {
    stateDir,
    feishuStateDir,
    findings,
    sessionEntries,
  };
}

function ensureBackupDir(stateDir: string, now: Date): string {
  const backupDir = path.join(stateDir, "backups", `${BACKUP_PREFIX}-${timestampForPath(now)}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  return backupDir;
}

function resolveUniquePath(candidate: string): string {
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  for (let index = 1; index < 1000; index += 1) {
    const next = `${candidate}.${index}`;
    if (!fs.existsSync(next)) {
      return next;
    }
  }
  throw new Error(`Unable to resolve unique path for ${candidate}`);
}

function movePathToBackup(params: {
  sourcePath: string;
  backupDir: string;
  relativeTarget: string;
}): boolean {
  if (!fs.existsSync(params.sourcePath)) {
    return false;
  }
  const targetPath = resolveUniquePath(path.join(params.backupDir, params.relativeTarget));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.renameSync(params.sourcePath, targetPath);
  return true;
}

function copyStoreBackup(params: { storePath: string; backupDir: string; agentId: string }) {
  if (!existsFile(params.storePath)) {
    return;
  }
  const targetPath = path.join(
    params.backupDir,
    "session-stores",
    params.agentId,
    path.basename(params.storePath),
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(params.storePath, resolveUniquePath(targetPath));
}

function collectSessionArtifactPaths(params: {
  storePath: string;
  entry: FeishuSessionEntry;
}): string[] {
  const artifacts = new Set<string>();
  for (const transcriptPath of resolveSessionTranscriptCandidates(params)) {
    artifacts.add(transcriptPath);
    if (transcriptPath.endsWith(".jsonl")) {
      const base = transcriptPath.slice(0, -".jsonl".length);
      artifacts.add(`${base}.trajectory.jsonl`);
      artifacts.add(`${base}.trajectory-path.json`);
    }
  }
  return [...artifacts].toSorted();
}

function archiveSessionArtifacts(params: {
  storePath: string;
  entries: FeishuSessionEntry[];
  archiveTimestamp: string;
}): number {
  const storeDir = path.dirname(params.storePath);
  const seen = new Set<string>();
  let archived = 0;
  for (const entry of params.entries) {
    for (const artifactPath of collectSessionArtifactPaths({
      storePath: params.storePath,
      entry,
    })) {
      if (
        seen.has(artifactPath) ||
        !isPathWithinRoot(artifactPath, storeDir) ||
        !existsFile(artifactPath)
      ) {
        continue;
      }
      seen.add(artifactPath);
      const archivedPath = resolveUniquePath(`${artifactPath}.deleted.${params.archiveTimestamp}`);
      fs.renameSync(artifactPath, archivedPath);
      archived += 1;
    }
  }
  return archived;
}

export async function repairFeishuDoctorState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<FeishuDoctorRepairReport> {
  const env = params.env ?? process.env;
  const now = params.now ?? new Date();
  const inspection = inspectFeishuDoctorState({ cfg: params.cfg, env });
  const backupDir = ensureBackupDir(inspection.stateDir, now);
  const archiveTimestamp = timestampForPath(now);
  const warnings: string[] = [];

  let rebuiltStateDir = false;
  try {
    rebuiltStateDir = movePathToBackup({
      sourcePath: inspection.feishuStateDir,
      backupDir,
      relativeTarget: FEISHU_STATE_DIR,
    });
    fs.mkdirSync(inspection.feishuStateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    warnings.push(`- Failed to rebuild Feishu local state: ${String(error)}`);
  }

  const entriesByStore = new Map<
    string,
    {
      agentId: string;
      entries: Array<{ key: string; entry: FeishuSessionEntry }>;
    }
  >();
  for (const entry of inspection.sessionEntries) {
    const existing = entriesByStore.get(entry.storePath);
    if (existing) {
      existing.entries.push({ key: entry.key, entry: entry.entry });
    } else {
      entriesByStore.set(entry.storePath, {
        agentId: entry.agentId,
        entries: [{ key: entry.key, entry: entry.entry }],
      });
    }
  }

  let removedSessionEntries = 0;
  let touchedSessionStores = 0;
  let archivedSessionArtifacts = 0;
  for (const [storePath, group] of [...entriesByStore.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    try {
      copyStoreBackup({ storePath, backupDir, agentId: group.agentId });
      archivedSessionArtifacts += archiveSessionArtifacts({
        storePath,
        entries: group.entries.map((entry) => entry.entry),
        archiveTimestamp,
      });
      const keys = new Set(group.entries.map((entry) => entry.key));
      const removed = await updateSessionStore(
        storePath,
        (store) => {
          let count = 0;
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              delete store[key];
              count += 1;
            }
          }
          return count;
        },
        {
          skipMaintenance: true,
          allowDropAcpMetaSessionKeys: [...keys],
        },
      );
      removedSessionEntries += removed;
      if (removed > 0) {
        touchedSessionStores += 1;
      }
    } catch (error) {
      warnings.push(
        `- Failed to archive Feishu sessions in ${formatDisplayPath(storePath)}: ${String(error)}`,
      );
    }
  }

  return {
    backupDir,
    rebuiltStateDir,
    removedSessionEntries,
    touchedSessionStores,
    archivedSessionArtifacts,
    warnings,
  };
}

function formatPreviewWarning(inspection: FeishuDoctorInspection): string {
  const previewFindings = inspection.findings.slice(0, 5).map(formatFinding);
  const remaining = inspection.findings.length - previewFindings.length;
  return [
    "- Feishu local channel state may need repair.",
    ...previewFindings,
    ...(remaining > 0 ? [`- ...and ${remaining} more Feishu state finding(s).`] : []),
    `- Repair will archive ${formatDisplayPath(inspection.feishuStateDir)} and ${countLabel(
      inspection.sessionEntries.length,
      "Feishu-scoped session entry",
      "Feishu-scoped session entries",
    )}, while preserving Feishu App ID/secret config.`,
    '- Run "openclaw doctor --fix" to rebuild Feishu local state.',
  ].join("\n");
}

function formatRepairChange(report: FeishuDoctorRepairReport): string {
  return [
    "Feishu local state repaired.",
    `- Backup dir: ${formatDisplayPath(report.backupDir)}`,
    `- Rebuilt Feishu runtime state: ${report.rebuiltStateDir ? "yes" : "no existing state"}`,
    `- Removed ${countLabel(
      report.removedSessionEntries,
      "Feishu-scoped session entry",
      "Feishu-scoped session entries",
    )} from ${countLabel(report.touchedSessionStores, "session store")}.`,
    `- Archived ${countLabel(report.archivedSessionArtifacts, "session artifact file")}.`,
    "- Preserved Feishu App ID/secret config.",
  ].join("\n");
}

function hasConfiguredFeishuChannel(cfg: OpenClawConfig): boolean {
  return Boolean(cfg.channels?.feishu);
}

export async function runFeishuDoctorSequence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<ChannelDoctorSequenceResult> {
  if (!hasConfiguredFeishuChannel(params.cfg)) {
    return { changeNotes: [], warningNotes: [] };
  }

  const inspection = inspectFeishuDoctorState({ cfg: params.cfg, env: params.env });
  if (inspection.findings.length === 0) {
    return { changeNotes: [], warningNotes: [] };
  }

  if (!params.shouldRepair) {
    return {
      changeNotes: [],
      warningNotes: [formatPreviewWarning(inspection)],
    };
  }

  const report = await repairFeishuDoctorState({ cfg: params.cfg, env: params.env });
  return {
    changeNotes: [formatRepairChange(report)],
    warningNotes: report.warnings,
  };
}

export const feishuDoctor: ChannelDoctorAdapter = {
  runConfigSequence: async ({ cfg, env, shouldRepair }) =>
    await runFeishuDoctorSequence({ cfg, env, shouldRepair }),
};
