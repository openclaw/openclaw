import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BLUEBUBBLES_MAILROOM_VERBS = [
  "show",
  "draft",
  "hold",
  "close",
  "classify",
  "digest",
  "health",
] as const;

export type BlueBubblesMailroomVerb = (typeof BLUEBUBBLES_MAILROOM_VERBS)[number];

export const BLUEBUBBLES_MAILROOM_REGISTRY: Record<BlueBubblesMailroomVerb, true> = {
  show: true,
  draft: true,
  hold: true,
  close: true,
  classify: true,
  digest: true,
  health: true,
};

export const BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES = {
  show: "mailroom.show",
  draft: "mailroom.draft",
  hold: "mailroom.hold",
  close: "mailroom.close",
  classify: "mailroom.classify",
  digest: "mailroom.digest",
  health: "mailroom.health",
} as const;

export const RESERVED_BLUEBUBBLES_MAILROOM_SEND_AUDIT_EVENT_TYPES = [
  "mailroom.send.requested",
  "mailroom.send.blocked",
] as const;

export type ReservedBlueBubblesMailroomSendAuditEventType =
  (typeof RESERVED_BLUEBUBBLES_MAILROOM_SEND_AUDIT_EVENT_TYPES)[number];

export type BlueBubblesMailroomQueueItem = {
  rank?: number;
  thread_id: string;
  account_id?: string;
  reply_target?: string;
  sender_id?: string;
  sender_name?: string;
  sender_label?: string;
  preview?: string;
  received_at?: number;
  attachments?: number;
  status?: string;
};

type BlueBubblesMailroomLatest = {
  generated_at?: string;
  items?: BlueBubblesMailroomQueueItem[];
};

type BlueBubblesMailroomThread = {
  thread_id: string;
  account_id?: string;
  reply_target?: string;
  sender_id?: string;
  sender_name?: string;
  sender_label?: string;
  status?: string;
  last_inbound_at?: number;
  last_inbound_text?: string;
  last_inbound_message_id?: string;
  last_inbound_short_id?: string;
  draft?: string;
  history?: unknown[];
};

export type BlueBubblesMailroomSafeItem = {
  rank: number | null;
  threadId: string;
  accountId: string | null;
  senderIdHash: string | null;
  senderLabel: string | null;
  previewHtml: string | null;
  receivedAt: number | null;
  attachments: number;
  status: string | null;
};

type BlueBubblesMailroomMetadata = Omit<BlueBubblesMailroomSafeItem, "previewHtml">;

type BlueBubblesMailroomLlmInput = {
  tools: [];
  thread: BlueBubblesMailroomSafeItem;
};

export type BlueBubblesMailroomLlmHooks = {
  draft?: (input: BlueBubblesMailroomLlmInput) => Promise<{ draft: string }>;
  classify?: (input: BlueBubblesMailroomLlmInput) => Promise<{ label: string; confidence?: number }>;
};

export type BlueBubblesMailroomClientOptions = {
  rootDir: string;
  llm?: BlueBubblesMailroomLlmHooks;
  classifyAllowlist?: string[];
  now?: () => Date;
};

export type BlueBubblesMailroomCommand =
  | { verb: "show"; threadId?: string; rank?: number }
  | { verb: "draft"; threadId?: string; rank?: number; note?: string }
  | { verb: "hold"; threadId?: string; rank?: number; reason?: string }
  | { verb: "close"; threadId?: string; rank?: number; reason?: string }
  | { verb: "classify"; threadId?: string; rank?: number }
  | { verb: "digest"; unknownOnly?: boolean }
  | { verb: "health" };

type QueueSnapshot = {
  latestGeneratedAt: string | null;
  latestItems: BlueBubblesMailroomQueueItem[];
  threads: Map<string, BlueBubblesMailroomThread>;
};

type Annotation = {
  threadId: string;
  updatedAt: string;
  status?: "held" | "closed";
  reason?: string;
  draft?: string;
  classification?: { label: string; confidence: number | null; source: "llm" | "rule" };
};

type AuditEvent = {
  id: string;
  type: string;
  at: string;
  threadIdHash?: string;
  rank?: number;
  annotationHash?: string;
};

const THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const UNKNOWN_SENDER_PATTERNS = [/^\s*unknown\s*$/i, /^\s*\[?unknown/i, /^\s*$/];

export function isBlueBubblesMailroomVerb(value: string): value is BlueBubblesMailroomVerb {
  return Object.prototype.hasOwnProperty.call(BLUEBUBBLES_MAILROOM_REGISTRY, value);
}

export function createBlueBubblesMailroomClient(options: BlueBubblesMailroomClientOptions) {
  return {
    verbs: BLUEBUBBLES_MAILROOM_VERBS,
    async run(command: BlueBubblesMailroomCommand) {
      return runBlueBubblesMailroomCommand(options, command);
    },
  };
}

export async function runBlueBubblesMailroomCommand(
  options: BlueBubblesMailroomClientOptions,
  command: BlueBubblesMailroomCommand,
) {
  if (!isBlueBubblesMailroomVerb(command.verb)) {
    throw new Error(`Unsupported BlueBubbles mailroom verb: ${(command as { verb: string }).verb}`);
  }

  if (command.verb === "health") {
    const snapshot = await readQueueSnapshot(options.rootDir);
    const health = await readMailroomHealth(options.rootDir, snapshot.latestGeneratedAt);
    await appendAuditEvent(options, { type: BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.health });
    return {
      verb: command.verb,
      ok: true,
      latestGeneratedAt: snapshot.latestGeneratedAt,
      threadCount: snapshot.threads.size,
      latestCount: snapshot.latestItems.length,
      ...health,
    };
  }

  if (command.verb === "digest") {
    const snapshot = await readQueueSnapshot(options.rootDir);
    await appendAuditEvent(options, { type: BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.digest });
    return {
      verb: command.verb,
      latestGeneratedAt: snapshot.latestGeneratedAt,
      items: snapshot.latestItems
        .filter((item) => !command.unknownOnly || isUnknownSender(item))
        .map(toMetadataOnlyItem),
    };
  }

  const snapshot = await readQueueSnapshot(options.rootDir);
  const queueItem = resolveQueueItem(snapshot, command);
  const safeItem = toSafeItem(queueItem);

  if (command.verb === "show") {
    await appendAuditEvent(options, {
      type: BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.show,
      threadId: queueItem.thread_id,
      rank: safeItem.rank ?? undefined,
    });
    return {
      verb: command.verb,
      item: safeItem,
    };
  }

  if (command.verb === "draft") {
    const draftResult = options.llm?.draft
      ? await options.llm.draft({ tools: [], thread: safeItem })
      : { draft: command.note?.trim() || "" };
    const annotation = await writeAnnotation(options, queueItem.thread_id, {
      draft: draftResult.draft,
    });
    await appendAuditEvent(options, {
      type: BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.draft,
      threadId: queueItem.thread_id,
      rank: safeItem.rank ?? undefined,
      annotation,
    });
    return {
      verb: command.verb,
      threadId: queueItem.thread_id,
      draftLength: draftResult.draft.length,
    };
  }

  if (command.verb === "hold" || command.verb === "close") {
    const status = command.verb === "hold" ? "held" : "closed";
    const annotation = await writeAnnotation(options, queueItem.thread_id, {
      status,
      reason: command.reason?.trim(),
    });
    await appendAuditEvent(options, {
      type:
        command.verb === "hold"
          ? BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.hold
          : BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.close,
      threadId: queueItem.thread_id,
      rank: safeItem.rank ?? undefined,
      annotation,
    });
    return {
      verb: command.verb,
      threadId: queueItem.thread_id,
      status,
    };
  }

  const allowed = isClassifyAllowed(options, queueItem);
  const classification = allowed && options.llm?.classify
    ? { ...(await options.llm.classify({ tools: [], thread: safeItem })), source: "llm" as const }
    : { label: allowed ? "unclassified" : "not_allowlisted", confidence: undefined, source: "rule" as const };
  const annotation = await writeAnnotation(options, queueItem.thread_id, {
    classification: {
      label: classification.label,
      confidence: classification.confidence ?? null,
      source: classification.source,
    },
  });
  await appendAuditEvent(options, {
    type: BLUEBUBBLES_MAILROOM_AUDIT_EVENT_TYPES.classify,
    threadId: queueItem.thread_id,
    rank: safeItem.rank ?? undefined,
    annotation,
  });
  return {
    verb: command.verb,
    threadId: queueItem.thread_id,
    classification: {
      label: classification.label,
      confidence: classification.confidence ?? null,
      source: classification.source,
    },
  };
}

async function readQueueSnapshot(rootDir: string): Promise<QueueSnapshot> {
  const latest = await readJson<BlueBubblesMailroomLatest>(path.join(rootDir, "latest.json"));
  const threads = new Map<string, BlueBubblesMailroomThread>();
  const threadsDir = path.join(rootDir, "threads");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(threadsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const thread = await readJson<BlueBubblesMailroomThread>(path.join(threadsDir, entry));
    if (thread?.thread_id && THREAD_ID_PATTERN.test(thread.thread_id)) {
      threads.set(thread.thread_id, thread);
    }
  }

  return {
    latestGeneratedAt: latest?.generated_at ?? null,
    latestItems: latest?.items ?? [],
    threads,
  };
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readMailroomHealth(rootDir: string, latestGeneratedAt: string | null) {
  const now = Date.now();
  const latestTime = latestGeneratedAt ? Date.parse(latestGeneratedAt) : NaN;
  return {
    freshnessMs: Number.isFinite(latestTime) ? Math.max(0, now - latestTime) : null,
    paths: {
      root: await readPathHealth(rootDir, "dir"),
      latest: await readPathHealth(path.join(rootDir, "latest.json"), "file"),
      threads: await readPathHealth(path.join(rootDir, "threads"), "dir"),
      annotations: await readPathHealth(path.join(rootDir, "annotations"), "dir"),
      audit: await readPathHealth(path.join(rootDir, "audit"), "dir"),
      auditEvents: await readPathHealth(path.join(rootDir, "audit", "agent-events.ndjson"), "file"),
    },
  };
}

async function readPathHealth(filePath: string, expected: "dir" | "file") {
  try {
    const stat = await fs.stat(filePath);
    const mode = stat.mode & 0o777;
    const typeOk = expected === "dir" ? stat.isDirectory() : stat.isFile();
    const modeOk = expected === "dir" ? mode === 0o700 : mode === 0o600;
    return { exists: true, mode, typeOk, modeOk };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, mode: null, typeOk: false, modeOk: false };
    }
    throw error;
  }
}

function resolveQueueItem(
  snapshot: QueueSnapshot,
  command: Extract<BlueBubblesMailroomCommand, { threadId?: string; rank?: number }>,
): BlueBubblesMailroomQueueItem {
  const item = command.threadId
    ? snapshot.latestItems.find((candidate) => candidate.thread_id === command.threadId)
    : snapshot.latestItems.find((candidate) => candidate.rank === command.rank);
  if (!item) {
    throw new Error("BlueBubbles mailroom queue item not found");
  }
  if (!THREAD_ID_PATTERN.test(item.thread_id)) {
    throw new Error("BlueBubbles mailroom queue item has an invalid thread id");
  }
  return item;
}

function toSafeItem(item: BlueBubblesMailroomQueueItem): BlueBubblesMailroomSafeItem {
  return {
    rank: typeof item.rank === "number" ? item.rank : null,
    threadId: item.thread_id,
    accountId: item.account_id ?? null,
    senderIdHash: item.sender_id ? sha256Hex(item.sender_id) : null,
    senderLabel: item.sender_label ?? item.sender_name ?? null,
    previewHtml: item.preview ? escapeHtml(normalizeWhitespace(item.preview).slice(0, 240)) : null,
    receivedAt: typeof item.received_at === "number" ? item.received_at : null,
    attachments: typeof item.attachments === "number" ? item.attachments : 0,
    status: item.status ?? null,
  };
}

function toMetadataOnlyItem(item: BlueBubblesMailroomQueueItem): BlueBubblesMailroomMetadata {
  const safe = toSafeItem(item);
  return {
    rank: safe.rank,
    threadId: safe.threadId,
    accountId: safe.accountId,
    senderIdHash: safe.senderIdHash,
    senderLabel: safe.senderLabel,
    receivedAt: safe.receivedAt,
    attachments: safe.attachments,
    status: safe.status,
  };
}

function isUnknownSender(item: BlueBubblesMailroomQueueItem): boolean {
  const label = item.sender_label ?? item.sender_name ?? "";
  return UNKNOWN_SENDER_PATTERNS.some((pattern) => pattern.test(label));
}

function isClassifyAllowed(
  options: BlueBubblesMailroomClientOptions,
  item: BlueBubblesMailroomQueueItem,
): boolean {
  const allowlist = options.classifyAllowlist ?? [];
  if (allowlist.length === 0) {
    return false;
  }
  const sender = item.sender_id?.trim();
  return Boolean(sender && allowlist.includes(sender));
}

async function writeAnnotation(
  options: BlueBubblesMailroomClientOptions,
  threadId: string,
  patch: Omit<Partial<Annotation>, "threadId" | "updatedAt">,
): Promise<Annotation> {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("Invalid BlueBubbles mailroom annotation thread id");
  }
  const dir = path.join(options.rootDir, "annotations");
  await ensurePrivateDir(dir);
  const filePath = path.join(dir, `${threadId}.json`);
  const current = (await readJson<Annotation>(filePath)) ?? { threadId, updatedAt: "" };
  const next: Annotation = {
    ...current,
    ...patch,
    threadId,
    updatedAt: nowIso(options),
  };
  const tempPath = path.join(dir, `.${threadId}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return next;
}

async function appendAuditEvent(
  options: BlueBubblesMailroomClientOptions,
  params: { type: string; threadId?: string; rank?: number; annotation?: Annotation },
): Promise<void> {
  const dir = path.join(options.rootDir, "audit");
  await ensurePrivateDir(dir);
  const event: AuditEvent = {
    id: createAuditId(params),
    type: params.type,
    at: nowIso(options),
    threadIdHash: params.threadId ? sha256Hex(params.threadId) : undefined,
    rank: params.rank,
    annotationHash: params.annotation ? sha256Hex(JSON.stringify(params.annotation)) : undefined,
  };
  const filePath = path.join(dir, "agent-events.ndjson");
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

function createAuditId(params: { type: string; threadId?: string; rank?: number }): string {
  return sha256Hex(`${params.type}\0${params.threadId ?? ""}\0${params.rank ?? ""}\0${randomUUID()}`);
}

function nowIso(options: BlueBubblesMailroomClientOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
