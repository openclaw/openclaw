/** Gateway reads that find each scribe's conversation and automation, and the state derived from them. */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  REPAIR_HEADING,
  SCRIBES,
  scribeDeclarationKey,
  scribeLabel,
  type ScribeDefinition,
} from "./scribes-catalog.js";

export type ScribeStatus =
  | "available"
  | "starting"
  | "on"
  | "paused"
  | "failing"
  | "done"
  | "missing";

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
  /** The run message is the prompt each scheduled run receives. */
  payload?: { kind: string; message?: string };
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

/** The `Scribe status: <state> — <sentence>` line every scribe turn ends with. */
type ScribeResult = {
  state: "on" | "done" | "failed";
  summary: string;
};

/** Everything the list and detail show for one scribe. */
export type ScribeSnapshot = {
  scribe: ScribeDefinition;
  status: ScribeStatus;
  session?: ScribeSession;
  job?: ScribeJob;
  result?: ScribeResult;
  /**
   * The page owes this ongoing scribe its first run: the latest turn answered `on` and its job
   * has never run. Setup turns never run their own job, so the page forces it once.
   */
  firstRunDue?: boolean;
};

/**
 * Whether a plugin a scribe needs can be used: not installed, turned off, installed but not
 * signed in to its service, or ready.
 */
export type PluginReadiness = "missing" | "disabled" | "needs-sign-in" | "ready";

/** Cheap facts for the Available rows. Absent fields could not be read. */
export type ScribeDetection = {
  activeConversations?: number;
  archivedConversations?: number;
  /** MEMORY.md in the agent workspace: null when it does not exist. */
  memoryFile?: { size?: number } | null;
  /** Readiness of the plugins scribes need, by plugin id. */
  plugins?: Record<string, PluginReadiness>;
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

// One status line: optional Markdown emphasis, the state, then an optional dash and sentence.
const STATUS_LINE = /^scribe status\s*:\s*(on|done|failed)\b\s*(?:[—–:-]+\s*)?(.*)$/i;

/**
 * The last `Scribe status:` line in one reply or run summary. Bold, code and quote marks are
 * ignored; underscores only at the line's ends, so names like `America/Los_Angeles` survive.
 */
export function statusFromText(text: string): ScribeResult | undefined {
  for (const line of text.split("\n").toReversed()) {
    const match = STATUS_LINE.exec(
      line
        .replace(/[*`>]/g, "")
        .trim()
        .replace(/^_+|_+$/g, ""),
    );
    if (match) {
      // SAFETY: the pattern only matches the three states.
      const state = match[1]!.toLowerCase() as ScribeResult["state"];
      return { state, summary: match[2]!.trim() };
    }
  }
  return undefined;
}

// The newest assistant message that carries a status line, with its position.
function parseScribeResult(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const result =
      isRecord(message) && message.role === "assistant"
        ? statusFromText(messageText(message))
        : undefined;
    if (result) {
      return { result, index };
    }
  }
  return { result: undefined, index: -1 };
}

// Position of the newest message sent to the scribe: a start, a repair or a scheduled run.
const lastSent = (messages: readonly unknown[]) =>
  messages.findLastIndex((message) => isRecord(message) && message.role === "user");

/**
 * Whether the page should force this scribe's first run: the latest message was a start, not a
 * repair, its turn answered `on`, and the job is enabled and has never run or started.
 */
const isFirstRunDue = (job: ScribeJob, result: ScribeResult, sent: unknown) =>
  !messageText(sent).trimStart().startsWith(REPAIR_HEADING) &&
  result.state === "on" &&
  job.enabled &&
  !job.state.lastRunAtMs &&
  !job.state.runningAtMs;

/** Session run states that mean its last turn stopped before it could answer. */
const ENDED_WITHOUT_RESULT = new Set(["failed", "interrupted", "killed", "timeout"]);

/**
 * Derive one scribe's state.
 * - No live conversation: Available, or Missing when its automation still exists.
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
  /** The conversation received a message: the page's start prompt at least. */
  setupSent: boolean;
}): ScribeStatus {
  const { session, job, result, setupSent } = input;
  if (!session || session.archived) {
    return job ? "missing" : "available";
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
    // No message: the start never reached the conversation (its send failed), so it can be
    // started again there. A start turn that ended without a status line needs a new start.
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

const SESSION_TARGET = "session:";

/** The sessions the scribe's automations target, by exact key; deleted ones are left out. */
async function describeTargets(host: ScribeReader, keyed: ScribeJob[]) {
  const keys = new Set(
    keyed.flatMap((job) =>
      job.sessionTarget?.startsWith(SESSION_TARGET)
        ? [job.sessionTarget.slice(SESSION_TARGET.length)]
        : [],
    ),
  );
  const rows = await Promise.all(
    [...keys].map((key) =>
      host.request<{ session?: unknown }>("sessions.describe", { key }).then((r) => r?.session),
    ),
  );
  return rows.filter((row): row is ScribeSession => isRecord(row) && typeof row.key === "string");
}

/**
 * Pair a scribe with its conversation and automation.
 * - With automations: the conversation is the one a job targets, read by its session key, so a
 *   renamed conversation stays paired. None left means it was deleted; the job stays (Missing).
 * - Without: no key is recorded, so the conversation is the newest unarchived session with the
 *   scribe's title, or an archived one.
 */
async function pairScribe(
  host: ScribeReader,
  agentId: string,
  scribe: ScribeDefinition,
  keyed: ScribeJob[],
) {
  const sessions = keyed.length
    ? await describeTargets(host, keyed)
    : await findSessions(host, agentId, scribe);
  const session = sessions.find((row) => !row.archived) ?? sessions[0];
  const job =
    keyed.find((entry) => session && entry.sessionTarget === `${SESSION_TARGET}${session.key}`) ??
    keyed[0];
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

/** Load every scribe's conversation, automation and last status line for one agent. */
export async function loadScribes(host: ScribeReader, agentId: string): Promise<ScribeSnapshot[]> {
  const jobs = await findJobs(host, agentId);
  return Promise.all(
    SCRIBES.map(async (scribe) => {
      const { session, job } = await pairScribe(
        host,
        agentId,
        scribe,
        jobs.get(scribeDeclarationKey(scribe.id)) ?? [],
      );
      const messages = session ? await readMessages(host, session, agentId) : [];
      const { result, index: resultIndex } = parseScribeResult(messages);
      const sentIndex = lastSent(messages);
      // A status line older than the latest message sent answers an earlier turn.
      const current = resultIndex > sentIndex ? result : undefined;
      const snapshot: ScribeSnapshot = {
        scribe,
        status: deriveStatus({ scribe, session, job, result: current, setupSent: sentIndex >= 0 }),
      };
      Object.assign(snapshot, session && { session }, job && { job }, result && { result });
      if (job && current && snapshot.status === "on") {
        snapshot.firstRunDue = isFirstRunDue(job, current, messages[sentIndex]);
      }
      return snapshot;
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

/**
 * Readiness of one plugin from plugins.inspect. A plugin the Gateway does not know is rejected
 * as an invalid request; any other failure is left unknown (undefined).
 */
export async function pluginReadiness(
  host: ScribeReader,
  pluginId: string,
): Promise<PluginReadiness | undefined> {
  const result = await host
    .request<{
      plugin?: { installed?: boolean; enabled?: boolean };
      mcpAuth?: { state?: string }[];
    }>("plugins.inspect", { pluginId })
    .catch((error: unknown) =>
      isRecord(error) && error.gatewayCode === "INVALID_REQUEST" ? null : undefined,
    );
  if (result === undefined) {
    return undefined;
  }
  if (!result?.plugin?.installed) {
    return "missing";
  }
  if (!result.plugin.enabled) {
    return "disabled";
  }
  // Every MCP server the plugin declares must be signed in; one without sign-in has no entries.
  return (result.mcpAuth ?? []).every((server) => server.state === "authorized")
    ? "ready"
    : "needs-sign-in";
}

// The plugins scribes need, once each.
const scribePluginIds = () => [
  ...new Set(SCRIBES.flatMap((scribe) => (scribe.plugin ? [scribe.plugin.id] : []))),
];

// Readiness by plugin id, leaving out plugins that could not be read.
async function detectPlugins(host: ScribeReader) {
  const ids = scribePluginIds();
  const states = await Promise.all(ids.map((id) => pluginReadiness(host, id)));
  return Object.fromEntries(
    ids.flatMap((id, i) => (states[i] === undefined ? [] : [[id, states[i]] as const])),
  );
}

/** Facts the Available rows can show honestly. Failed reads leave their fields out. */
export async function detectSources(host: ScribeReader, agentId: string): Promise<ScribeDetection> {
  const [active, archived, files, plugins] = await Promise.allSettled([
    conversationCount(host, agentId, false),
    conversationCount(host, agentId, true),
    host.request<{ files?: unknown[] }>("agents.files.list", { agentId }),
    detectPlugins(host),
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
  if (plugins.status === "fulfilled" && Object.keys(plugins.value).length) {
    detection.plugins = plugins.value;
  }
  return detection;
}
