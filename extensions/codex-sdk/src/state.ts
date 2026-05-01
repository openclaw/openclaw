import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/acpx";

export type CodexSessionRecord = {
  sessionKey: string;
  backend: string;
  agent: string;
  routeId: string;
  routeLabel: string;
  model?: string;
  modelReasoningEffort?: string;
  cwd?: string;
  threadId?: string;
  lifecycle: "started" | "resumed" | "configured";
  status: "active" | "error" | "closed";
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastEventAt?: string;
  lastError?: string;
};

export type CodexEventRecord = {
  id: string;
  at: string;
  sessionKey: string;
  backend: string;
  routeId: string;
  routeLabel: string;
  threadId?: string;
  sdkEventType: string;
  mappedEvents: AcpRuntimeEvent[];
};

export type CodexProposalRecord = {
  id: string;
  at: string;
  updatedAt?: string;
  sessionKey: string;
  routeId: string;
  routeLabel: string;
  title: string;
  summary?: string;
  body?: string;
  actions?: string[];
  status: "new" | "accepted" | "dismissed";
  sourceEventId: string;
  executedAt?: string;
  executedSessionKey?: string;
  executedThreadId?: string;
  executionRouteId?: string;
  lastExecutionError?: string;
};

export type CodexCompatibilityRecord = {
  schemaVersion: 2;
  id: string;
  checkedAt: string;
  ok: boolean;
  backend: string;
  sdkPackage: string;
  sdkVersion: string;
  defaultRoute: string;
  checks: Array<{
    id: string;
    status: "pass" | "fail" | "warn" | "not_checked";
    message: string;
  }>;
};

export type CodexSessionUpsert = Omit<
  CodexSessionRecord,
  "createdAt" | "updatedAt" | "turnCount" | "lastEventAt"
>;

export type CodexEventInput = Omit<CodexEventRecord, "id" | "at">;
export type CodexProposalCreateInput = Pick<CodexProposalRecord, "title"> &
  Partial<
    Pick<
      CodexProposalRecord,
      "summary" | "body" | "actions" | "sessionKey" | "routeId" | "routeLabel" | "sourceEventId"
    >
  >;
export type CodexProposalPatch = Partial<
  Pick<
    CodexProposalRecord,
    | "status"
    | "executedAt"
    | "executedSessionKey"
    | "executedThreadId"
    | "executionRouteId"
    | "lastExecutionError"
  >
>;

export type CodexNativeStateStore = {
  rootDir: string;
  upsertSession(record: CodexSessionUpsert): Promise<void>;
  recordEvent(event: CodexEventInput): Promise<CodexEventRecord>;
  getSession(sessionKey: string): Promise<CodexSessionRecord | null>;
  listSessions(limit?: number): Promise<CodexSessionRecord[]>;
  listEvents(sessionKey: string, limit?: number): Promise<CodexEventRecord[]>;
  createProposal(input: CodexProposalCreateInput): Promise<CodexProposalRecord>;
  getProposal(id: string): Promise<CodexProposalRecord | null>;
  listProposals(limit?: number): Promise<CodexProposalRecord[]>;
  updateProposalStatus(
    id: string,
    status: CodexProposalRecord["status"],
  ): Promise<CodexProposalRecord | null>;
  updateProposal(id: string, patch: CodexProposalPatch): Promise<CodexProposalRecord | null>;
  writeCompatibilityRecord(record: CodexCompatibilityRecord): Promise<void>;
  listCompatibilityRecords(limit?: number): Promise<CodexCompatibilityRecord[]>;
  checkWritable(): Promise<void>;
};

type StateOptions = {
  maxEventsPerSession: number;
  proposalInboxLimit: number;
};

const DEFAULT_OPTIONS: StateOptions = {
  maxEventsPerSession: 400,
  proposalInboxLimit: 200,
};

export class FileCodexNativeStateStore implements CodexNativeStateStore {
  readonly rootDir: string;
  private readonly options: StateOptions;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(params: { stateDir: string; options?: Partial<StateOptions> }) {
    this.rootDir = path.join(params.stateDir, "codex-sdk");
    this.options = { ...DEFAULT_OPTIONS, ...params.options };
  }

  async upsertSession(record: CodexSessionUpsert): Promise<void> {
    await this.withWriteLock(async () => {
      const sessions = await this.readSessionsMap();
      const now = new Date().toISOString();
      const existing = sessions[record.sessionKey];
      sessions[record.sessionKey] = {
        ...existing,
        ...record,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        turnCount: existing?.turnCount ?? 0,
        ...(existing?.lastEventAt ? { lastEventAt: existing.lastEventAt } : {}),
      };
      await this.writeJson(this.sessionsPath, sessions);
    });
  }

  async recordEvent(event: CodexEventInput): Promise<CodexEventRecord> {
    const record: CodexEventRecord = {
      ...event,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
    await this.withWriteLock(async () => {
      await this.appendBoundedJsonl(
        this.eventsPathFor(event.sessionKey),
        record,
        this.options.maxEventsPerSession,
      );
      const sessions = await this.readSessionsMap();
      const existing = sessions[event.sessionKey];
      if (existing) {
        const error = event.mappedEvents.find((entry) => entry.type === "error");
        sessions[event.sessionKey] = {
          ...existing,
          updatedAt: record.at,
          lastEventAt: record.at,
          threadId: event.threadId ?? existing.threadId,
          status: error ? "error" : existing.status,
          turnCount:
            existing.turnCount +
            (event.mappedEvents.some((entry) => entry.type === "done") ? 1 : 0),
          ...(error ? { lastError: error.message } : {}),
        };
        await this.writeJson(this.sessionsPath, sessions);
      }
      await this.recordProposalsFromEvent(record);
    });
    return record;
  }

  async getSession(sessionKey: string): Promise<CodexSessionRecord | null> {
    return (await this.readSessionsMap())[sessionKey] ?? null;
  }

  async listSessions(limit = 20): Promise<CodexSessionRecord[]> {
    const sessions = Object.values(await this.readSessionsMap());
    return sessions
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, limit));
  }

  async listEvents(
    sessionKey: string,
    limit = this.options.maxEventsPerSession,
  ): Promise<CodexEventRecord[]> {
    return (await this.readJsonl<CodexEventRecord>(this.eventsPathFor(sessionKey))).slice(
      -Math.max(1, limit),
    );
  }

  async listProposals(limit = this.options.proposalInboxLimit): Promise<CodexProposalRecord[]> {
    return (await this.readJsonl<CodexProposalRecord>(this.proposalsPath))
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .slice(0, Math.max(1, limit));
  }

  async createProposal(input: CodexProposalCreateInput): Promise<CodexProposalRecord> {
    const now = new Date().toISOString();
    const record: CodexProposalRecord = {
      id: randomUUID(),
      at: now,
      sessionKey: input.sessionKey ?? "codex:backchannel",
      routeId: input.routeId ?? "backchannel",
      routeLabel: input.routeLabel ?? "codex/backchannel",
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
      status: "new",
      sourceEventId: input.sourceEventId ?? `manual:${randomUUID()}`,
    };
    await this.withWriteLock(async () => {
      const existing = await this.readJsonl<CodexProposalRecord>(this.proposalsPath);
      const next = [...existing, record].slice(-Math.max(1, this.options.proposalInboxLimit));
      await this.writeJsonl(this.proposalsPath, next);
    });
    return record;
  }

  async getProposal(id: string): Promise<CodexProposalRecord | null> {
    const proposals = await this.readJsonl<CodexProposalRecord>(this.proposalsPath);
    return proposals.find((proposal) => proposal.id === id) ?? null;
  }

  async updateProposalStatus(
    id: string,
    status: CodexProposalRecord["status"],
  ): Promise<CodexProposalRecord | null> {
    return await this.updateProposal(id, { status });
  }

  async updateProposal(id: string, patch: CodexProposalPatch): Promise<CodexProposalRecord | null> {
    return await this.withWriteLock(async () => {
      const proposals = await this.readJsonl<CodexProposalRecord>(this.proposalsPath);
      let updated: CodexProposalRecord | null = null;
      const next = proposals.map((proposal) => {
        if (proposal.id !== id) {
          return proposal;
        }
        updated = {
          ...proposal,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        return updated;
      });
      if (updated) {
        await this.writeJsonl(this.proposalsPath, next);
      }
      return updated;
    });
  }

  async writeCompatibilityRecord(record: CodexCompatibilityRecord): Promise<void> {
    await this.withWriteLock(async () => {
      await this.appendJsonl(this.compatibilityPath, record);
    });
  }

  async listCompatibilityRecords(limit = 10): Promise<CodexCompatibilityRecord[]> {
    return (await this.readJsonl<CodexCompatibilityRecord>(this.compatibilityPath))
      .toSorted((a, b) => b.checkedAt.localeCompare(a.checkedAt))
      .slice(0, Math.max(1, limit));
  }

  async checkWritable(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const probePath = path.join(this.rootDir, `.write-probe-${process.pid}-${Date.now()}`);
    await fs.writeFile(probePath, "ok", "utf8");
    await fs.rm(probePath, { force: true });
  }

  private get sessionsPath(): string {
    return path.join(this.rootDir, "sessions.json");
  }

  private get proposalsPath(): string {
    return path.join(this.rootDir, "proposal-inbox.jsonl");
  }

  private get compatibilityPath(): string {
    return path.join(this.rootDir, "compatibility-records.jsonl");
  }

  private eventsPathFor(sessionKey: string): string {
    return path.join(this.rootDir, "events", `${safeSegment(sessionKey)}.jsonl`);
  }

  private async readSessionsMap(): Promise<Record<string, CodexSessionRecord>> {
    return await this.readJson<Record<string, CodexSessionRecord>>(this.sessionsPath, {});
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  }

  private async readJsonl<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeJsonl(filePath: string, records: unknown[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(
      tempPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await fs.rename(tempPath, filePath);
  }

  private async appendJsonl(filePath: string, record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async appendBoundedJsonl<T>(filePath: string, record: T, limit: number): Promise<void> {
    const next = [...(await this.readJsonl<T>(filePath)), record].slice(-Math.max(1, limit));
    await this.writeJsonl(filePath, next);
  }

  private async recordProposalsFromEvent(event: CodexEventRecord): Promise<void> {
    const proposals = event.mappedEvents.flatMap((mapped) => {
      if (mapped.type !== "text_delta" && mapped.type !== "status") {
        return [];
      }
      return extractCodexProposalsFromText(mapped.text).map((proposal) => ({
        ...proposal,
        id: randomUUID(),
        at: event.at,
        sessionKey: event.sessionKey,
        routeId: event.routeId,
        routeLabel: event.routeLabel,
        status: "new" as const,
        sourceEventId: event.id,
      }));
    });
    if (proposals.length === 0) {
      return;
    }
    const existing = await this.readJsonl<CodexProposalRecord>(this.proposalsPath);
    const next = [...existing, ...proposals].slice(-Math.max(1, this.options.proposalInboxLimit));
    await this.writeJsonl(this.proposalsPath, next);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

export function extractCodexProposalsFromText(
  text: string,
): Array<Pick<CodexProposalRecord, "title" | "summary" | "body" | "actions">> {
  const proposals: Array<Pick<CodexProposalRecord, "title" | "summary" | "body" | "actions">> = [];
  const fence = /```openclaw-proposal\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fence)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const proposal = normalizeProposal(entry);
        if (proposal) {
          proposals.push(proposal);
        }
      }
    } catch {
      proposals.push({ title: "Unparsed Codex proposal", body: raw });
    }
  }
  return proposals;
}

function normalizeProposal(
  value: unknown,
): Pick<CodexProposalRecord, "title" | "summary" | "body" | "actions"> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim().slice(0, 80)
        : "";
  if (!title) {
    return null;
  }
  const actions = Array.isArray(record.actions)
    ? record.actions.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : undefined;
  return {
    title,
    ...(typeof record.summary === "string" && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    ...(typeof record.body === "string" && record.body.trim() ? { body: record.body.trim() } : {}),
    ...(actions && actions.length > 0 ? { actions: actions.map((entry) => entry.trim()) } : {}),
  };
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 120) || "session"
  );
}
