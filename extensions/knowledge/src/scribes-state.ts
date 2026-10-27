/** Gateway reads that find each scribe's conversation and automation, and the state derived from them. */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SCRIBES,
  scribeById,
  scribeDeclarationKey,
  scribeLabel,
  type ScribeDefinition,
  type ScribeSetup,
} from "./scribes-catalog.js";

export type ScribeStatus =
  | "available"
  | "starting"
  | "on"
  | "paused"
  | "failing"
  | "done"
  | "reauth";

/** The session row fields the Scribes view reads. */
type ScribeSession = {
  key: string;
  sessionId?: string;
  displayName?: string;
  agentId?: string;
  archived?: boolean;
  createdAt?: number;
  model?: string;
  status?: string;
};

/** The cron job fields the Scribes view reads and patches. */
export type ScribeJob = {
  id: string;
  declarationKey?: string;
  enabled: boolean;
  configRevision?: string;
  sessionTarget?: string;
  schedule: { kind: string; expr?: string; tz?: string; everyMs?: number; at?: string };
  failureAlert?: false | { after?: number };
  createdAtMs?: number;
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: "ok" | "error" | "skipped";
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors?: number;
    autoDisabled?: { reason: string };
  };
};

/** One cron run history entry, as cron.runs returns it. */
export type ScribeRun = {
  ts: number;
  runAtMs?: number;
  status?: "ok" | "error" | "skipped";
  completionStatus?: "succeeded" | "failed" | "unknown";
  summary?: string;
  error?: string;
  durationMs?: number;
  model?: string;
  usage?: { total_tokens?: number };
};

/** The `SCRIBE_RESULT` line every scribe turn ends with. */
type ScribeResult = {
  scribe: string;
  state: "on" | "done" | "failed";
  jobId: string | null;
  summary: string;
};

/** Everything the list and detail show for one scribe. */
export type ScribeSnapshot = {
  scribe: ScribeDefinition;
  status: ScribeStatus;
  session?: ScribeSession;
  job?: ScribeJob;
  result?: ScribeResult;
  /** Options from the latest setup or repair message in the conversation. */
  setup?: ScribeSetup;
  /**
   * The page owes this ongoing scribe its first run: the setup turn answered `on` with a job
   * that has never run. Setup turns never run their own job, so the page forces it once.
   */
  firstRunDue?: boolean;
};

/** Cheap facts for the Available rows. Absent fields could not be read. */
export type ScribeDetection = {
  activeConversations?: number;
  archivedConversations?: number;
  /** MEMORY.md in the agent workspace: null when it does not exist. */
  memoryFile?: { size?: number } | null;
};

/** The Gateway access scribe reads need: the page host's authenticated request. */
type ScribeReader = Pick<ControlUiHost, "request">;

/** Plain text of one transcript message: string content or its text parts. */
function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const content = message.content ?? message.text;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

/** The last valid `SCRIBE_RESULT` line in one reply or run summary. */
export function resultFromText(text: string): ScribeResult | undefined {
  for (const line of text.split("\n").toReversed()) {
    const match = /^\s*SCRIBE_RESULT\s+(\{.*\})\s*$/.exec(line);
    if (!match) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (
        isRecord(value) &&
        typeof value.scribe === "string" &&
        (value.state === "on" || value.state === "done" || value.state === "failed") &&
        (typeof value.jobId === "string" || value.jobId === null) &&
        typeof value.summary === "string"
      ) {
        return {
          scribe: value.scribe,
          state: value.state,
          jobId: value.jobId,
          summary: value.summary,
        };
      }
    } catch {
      // Not JSON: keep looking at earlier lines.
    }
  }
  return undefined;
}

// The newest assistant message that carries a valid result line, with its position.
function parseScribeResult(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const result =
      isRecord(message) && message.role === "assistant"
        ? resultFromText(messageText(message))
        : undefined;
    if (result) {
      return { result, index };
    }
  }
  return { result: undefined, index: -1 };
}

/** Options from the newest setup or repair message the page sent, with its kind and position. */
function parseSetup(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    const match =
      /^Knowledge scribe (setup|repair): ([a-z-]+)\n[^\n]*\n```json\n(\{.*\})\n```/.exec(
        messageText(message).trim(),
      );
    if (!match || !scribeById(match[2]!)) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(match[3]!);
      if (
        isRecord(value) &&
        value.scribe === match[2] &&
        (value.mode === "once" || value.mode === "ongoing") &&
        isRecord(value.options) &&
        typeof value.timezone === "string" &&
        typeof value.agentId === "string"
      ) {
        // SAFETY: fields checked above; options are the page's own serialized choices.
        return { setup: value as ScribeSetup, kind: match[1]!, index };
      }
    } catch {
      // A hand-edited setup message: treat as unknown options.
    }
  }
  return { setup: undefined, kind: undefined, index: -1 };
}

/**
 * Whether the page should force this scribe's first run: the latest page message was an ongoing
 * setup, the conversation answered it with `on` for this job, and the job has not run yet.
 */
function isFirstRunDue(job: ScribeJob, result: ScribeResult, setup: ScribeSetup, kind: string) {
  return (
    kind === "setup" &&
    setup.mode === "ongoing" &&
    result.state === "on" &&
    (result.jobId === null || result.jobId === job.id) &&
    job.enabled &&
    !job.state.lastRunAtMs &&
    !job.state.runningAtMs
  );
}

/** Session run states that mean its last turn stopped before it could answer. */
const ENDED_WITHOUT_RESULT = new Set(["failed", "interrupted", "killed", "timeout"]);

/**
 * Derive one scribe's state.
 * - No live conversation: Available, or Needs reauthorization when its automation still exists.
 * - With an automation: Paused, Failing or On from the scheduler state.
 * - Without one: Done / Failing from the last result line, Available when an ongoing scribe was
 *   turned off or the setup never reached the conversation, Starting until the conversation
 *   answers its setup, and Failing when that turn stopped without an answer.
 */
function deriveStatus(input: {
  scribe: ScribeDefinition;
  session?: ScribeSession;
  job?: ScribeJob;
  result?: ScribeResult;
  /** The conversation holds a setup or repair message from the page. */
  setupSent: boolean;
}): ScribeStatus {
  const { session, job, result, setupSent } = input;
  if (!session || session.archived) {
    return job ? "reauth" : "available";
  }
  if (job) {
    if (job.state.autoDisabled) {
      return "failing";
    }
    if (!job.enabled) {
      return "paused";
    }
    // A current failed answer (setup, repair or a run) outranks a healthy-looking job.
    if (result?.state === "failed") {
      return "failing";
    }
    return (job.state.consecutiveErrors ?? 0) > 0 || job.state.lastRunStatus === "error"
      ? "failing"
      : "on";
  }
  if (!result) {
    // No setup message: the start never reached the conversation (its send failed), so it can
    // be started again there. A setup turn that ended without a result line needs Retry/Repair.
    if (!setupSent) {
      return "available";
    }
    return session.status && ENDED_WITHOUT_RESULT.has(session.status) ? "failing" : "starting";
  }
  return result.state === "done" ? "done" : result.state === "failed" ? "failing" : "available";
}

/** Sessions shown as this scribe's conversation (by display name), archived ones included. */
async function findSessions(host: ScribeReader, agentId: string, scribe: ScribeDefinition) {
  const title = scribeLabel(scribe);
  const result = await host.request<{ sessions?: unknown[] }>("sessions.list", {
    agentId,
    search: title,
    archived: "all",
    limit: 20,
  });
  return (result?.sessions ?? []).filter(
    (row): row is ScribeSession =>
      isRecord(row) && typeof row.key === "string" && row.displayName === title,
  );
}

/**
 * Pair a scribe with its conversation and automation. An ongoing scribe's conversation is the
 * one its job targets; otherwise the newest unarchived session with the scribe's title. The job
 * is the one targeting that conversation, or any job with the key (shown as needing repair).
 */
function pairScribe(sessions: ScribeSession[], keyed: ScribeJob[]) {
  const targets = new Set(keyed.map((job) => job.sessionTarget));
  const session =
    sessions.find((row) => targets.has(`session:${row.key}`)) ??
    sessions.find((row) => !row.archived) ??
    sessions[0];
  const job =
    keyed.find((entry) => session && entry.sessionTarget === `session:${session.key}`) ?? keyed[0];
  return { session, job };
}

/** All of this agent's scribe automations, grouped by declarationKey. */
async function findJobs(host: ScribeReader, agentId: string) {
  const jobs = new Map<string, ScribeJob[]>();
  // A bounded walk: scribe jobs are a handful among the agent's automations.
  for (let offset: number | null = 0, page = 0; offset !== null && page < 10; page++) {
    const result: { jobs?: unknown[]; nextOffset?: number | null; hasMore?: boolean } =
      await host.request("cron.list", { agentId, includeDisabled: true, limit: 200, offset });
    for (const job of result?.jobs ?? []) {
      if (
        isRecord(job) &&
        typeof job.id === "string" &&
        typeof job.declarationKey === "string" &&
        job.declarationKey.startsWith("knowledge:scribe:")
      ) {
        // SAFETY: a scheduler job row; the fields the view reads are optional or checked.
        jobs.set(job.declarationKey, [...(jobs.get(job.declarationKey) ?? []), job as ScribeJob]);
      }
    }
    offset = result?.hasMore && typeof result.nextOffset === "number" ? result.nextOffset : null;
  }
  return jobs;
}

/** Recent messages of a scribe conversation; empty when the transcript can't be read. */
async function readMessages(host: ScribeReader, session: ScribeSession, agentId: string) {
  const history = await host
    .request<{ messages?: unknown[] }>("chat.history", {
      sessionKey: session.key,
      agentId,
      limit: 100,
    })
    .catch(() => undefined);
  return history?.messages ?? [];
}

/** Load every scribe's conversation, automation and last result for one agent. */
export async function loadScribes(host: ScribeReader, agentId: string): Promise<ScribeSnapshot[]> {
  const [jobs, sessions] = await Promise.all([
    findJobs(host, agentId),
    Promise.all(SCRIBES.map((scribe) => findSessions(host, agentId, scribe))),
  ]);
  return Promise.all(
    SCRIBES.map(async (scribe, i) => {
      const { session, job } = pairScribe(
        sessions[i]!,
        jobs.get(scribeDeclarationKey(scribe.id)) ?? [],
      );
      const messages = session ? await readMessages(host, session, agentId) : [];
      const { result, index: resultIndex } = parseScribeResult(messages);
      const { setup, kind, index: setupIndex } = parseSetup(messages);
      // A result older than the latest setup or repair message answers an earlier start.
      const current = resultIndex > setupIndex ? result : undefined;
      const snapshot: ScribeSnapshot = {
        scribe,
        status: deriveStatus({ scribe, session, job, result: current, setupSent: setupIndex >= 0 }),
      };
      Object.assign(snapshot, session && { session }, job && { job }, result && { result });
      if (job && current && setup && kind && snapshot.status === "on") {
        snapshot.firstRunDue = isFirstRunDue(job, current, setup, kind);
      }
      return setup ? Object.assign(snapshot, { setup }) : snapshot;
    }),
  );
}

/** Recent runs of a scribe's automation, newest first. */
export async function loadRuns(host: ScribeReader, job: ScribeJob, agentId: string) {
  const result = await host.request<{ entries?: ScribeRun[] }>("cron.runs", {
    agentId,
    scope: "job",
    id: job.id,
    limit: 10,
    sortDir: "desc",
    view: "summary",
  });
  return result?.entries ?? [];
}

// Total rows of one sessions.list query; undefined when the Gateway did not count them.
async function conversationCount(host: ScribeReader, agentId: string, archived: boolean) {
  const result = await host.request<{ totalCount?: number; count?: number; nextOffset?: unknown }>(
    "sessions.list",
    {
      agentId,
      archived,
      limit: 1,
      excludeCron: true,
      excludeSubagents: true,
      excludeSystem: true,
      excludeDock: true,
    },
  );
  if (typeof result?.totalCount === "number") {
    return result.totalCount;
  }
  return result?.count === 0 ? 0 : undefined;
}

/** Facts the Available rows can show honestly. Failed reads leave their fields out. */
export async function detectSources(host: ScribeReader, agentId: string): Promise<ScribeDetection> {
  const [active, archived, files] = await Promise.allSettled([
    conversationCount(host, agentId, false),
    conversationCount(host, agentId, true),
    host.request<{ files?: unknown[] }>("agents.files.list", { agentId }),
  ]);
  const detection: ScribeDetection = {};
  if (active.status === "fulfilled" && active.value !== undefined) {
    detection.activeConversations = active.value;
  }
  if (archived.status === "fulfilled" && archived.value !== undefined) {
    detection.archivedConversations = archived.value;
  }
  if (files.status === "fulfilled") {
    const memory = (files.value?.files ?? []).find(
      (file) => isRecord(file) && file.name === "MEMORY.md",
    );
    if (isRecord(memory)) {
      detection.memoryFile =
        memory.missing === true
          ? null
          : typeof memory.size === "number"
            ? { size: memory.size }
            : {};
    }
  }
  return detection;
}
