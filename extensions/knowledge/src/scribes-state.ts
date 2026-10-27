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
  label?: string;
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

// The newest assistant message that carries a valid result line.
function parseScribeResult(messages: readonly unknown[]): ScribeResult | undefined {
  for (const message of [...messages].toReversed()) {
    const result =
      isRecord(message) && message.role === "assistant"
        ? resultFromText(messageText(message))
        : undefined;
    if (result) {
      return result;
    }
  }
  return undefined;
}

/** Options from the newest setup or repair message the page sent this conversation. */
function parseSetup(messages: readonly unknown[]): ScribeSetup | undefined {
  for (const message of [...messages].toReversed()) {
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    const match =
      /^Knowledge scribe (?:setup|repair): ([a-z-]+)\n[^\n]*\n```json\n(\{.*\})\n```/.exec(
        messageText(message).trim(),
      );
    if (!match || !scribeById(match[1]!)) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(match[2]!);
      if (
        isRecord(value) &&
        value.scribe === match[1] &&
        (value.mode === "once" || value.mode === "ongoing") &&
        isRecord(value.options) &&
        typeof value.timezone === "string" &&
        typeof value.agentId === "string"
      ) {
        // SAFETY: fields checked above; options are the page's own serialized choices.
        return value as ScribeSetup;
      }
    } catch {
      // A hand-edited setup message: treat as unknown options.
    }
  }
  return undefined;
}

/**
 * Derive one scribe's state.
 * - No live conversation: Available, or Needs reauthorization when its automation still exists.
 * - With an automation: Paused, Failing or On from the scheduler state.
 * - Without one: Done / Failing from the last result line, Available when an ongoing scribe was
 *   turned off, and Starting until the conversation reports its first result.
 */
function deriveStatus(input: {
  scribe: ScribeDefinition;
  session?: ScribeSession;
  job?: ScribeJob;
  result?: ScribeResult;
}): ScribeStatus {
  const { session, job, result } = input;
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
    return (job.state.consecutiveErrors ?? 0) > 0 || job.state.lastRunStatus === "error"
      ? "failing"
      : "on";
  }
  if (!result) {
    return "starting";
  }
  return result.state === "done" ? "done" : result.state === "failed" ? "failing" : "available";
}

/** The newest session holding this scribe's label, preferring one that is not archived. */
async function findSession(host: ScribeReader, agentId: string, scribe: ScribeDefinition) {
  const label = scribeLabel(scribe);
  const result = await host.request<{ sessions?: unknown[] }>("sessions.list", {
    agentId,
    label,
    archived: "all",
    limit: 5,
  });
  const rows = (result?.sessions ?? []).filter(
    (row): row is ScribeSession =>
      isRecord(row) && typeof row.key === "string" && row.label === label,
  );
  return rows.find((row) => !row.archived) ?? rows[0];
}

/** All of this agent's scribe automations, keyed by declarationKey. */
async function findJobs(host: ScribeReader, agentId: string) {
  const jobs = new Map<string, ScribeJob>();
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
        jobs.set(job.declarationKey, job as ScribeJob);
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
    Promise.all(SCRIBES.map((scribe) => findSession(host, agentId, scribe))),
  ]);
  return Promise.all(
    SCRIBES.map(async (scribe, i) => {
      const session = sessions[i];
      const job = jobs.get(scribeDeclarationKey(scribe.id));
      const messages = session ? await readMessages(host, session, agentId) : [];
      const result = parseScribeResult(messages);
      const setup = parseSetup(messages);
      const snapshot: ScribeSnapshot = {
        scribe,
        status: deriveStatus({ scribe, session, job, result }),
      };
      Object.assign(snapshot, session && { session }, job && { job }, result && { result });
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
