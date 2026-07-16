import { createHash } from "node:crypto";
import type { AgentMail, AgentMailClient } from "agentmail";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { createAgentMailClient } from "./client.js";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CURSOR_VERSION = 1;
const PAGE_LIMIT = 100;

export const AGENTMAIL_REST_CATCH_UP_NAMESPACE = "agentmail.rest-catch-up";
export const AGENTMAIL_REST_CATCH_UP_MAX_ACCOUNTS = 1_000;
export const AGENTMAIL_REST_CATCH_UP_OVERLAP_MS = 5 * 60_000;

export type AgentMailCatchUpCursor = {
  version: typeof CURSOR_VERSION;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
};

type AgentMailCatchUpLog = {
  info?: (message: string) => void;
  error?: (message: string) => void;
};

export type AgentMailCatchUpSession = {
  run(params: {
    receive: (record: AgentMailIngressRecord) => Promise<void>;
    abortSignal: AbortSignal;
  }): Promise<void>;
};

export type AgentMailCatchUpSupervisor = {
  request(): void;
  settle(): Promise<void>;
};

function catchUpRetryDelayMs(attempt: number): number {
  return computeBackoff({ initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 }, attempt);
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  try {
    await sleepWithAbort(delayMs, signal);
    return !signal.aborted;
  } catch {
    return false;
  }
}

export function createAgentMailCatchUpSupervisor(params: {
  session: AgentMailCatchUpSession;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  abortSignal: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
  log?: AgentMailCatchUpLog;
}): AgentMailCatchUpSupervisor {
  let requested = false;
  let worker: Promise<void> | undefined;
  const retryDelay = params.retryDelayMs ?? catchUpRetryDelayMs;

  const request = (): void => {
    requested = true;
    if (worker) {
      return;
    }
    worker = (async () => {
      let attempts = 0;
      while (!params.abortSignal.aborted && requested) {
        requested = false;
        try {
          await params.session.run({
            receive: params.receive,
            abortSignal: params.abortSignal,
          });
          attempts = 0;
        } catch (error) {
          attempts += 1;
          requested = true;
          params.log?.error?.(
            `AgentMail REST catch-up failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!(await waitForRetry(params.abortSignal, retryDelay(attempts)))) {
            return;
          }
        }
      }
    })().finally(() => {
      worker = undefined;
      if (requested && !params.abortSignal.aborted) {
        request();
      }
    });
  };

  return {
    request,
    settle: async () => {
      await worker;
    },
  };
}

function cursorKey(account: ResolvedAgentMailAccount): string {
  return createHash("sha256").update(`${account.accountId}\n${account.inboxId}`).digest("hex");
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeCursor(value: unknown): AgentMailCatchUpCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const cursor = value as Partial<AgentMailCatchUpCursor>;
  if (
    cursor.version !== CURSOR_VERSION ||
    !validTimestamp(cursor.baselineAtMs) ||
    !validTimestamp(cursor.highWaterAtMs) ||
    typeof cursor.established !== "boolean"
  ) {
    return null;
  }
  return {
    version: CURSOR_VERSION,
    baselineAtMs: cursor.baselineAtMs,
    highWaterAtMs: Math.max(cursor.baselineAtMs, cursor.highWaterAtMs),
    established: cursor.established,
  };
}

function isReceivedMessage(message: AgentMail.MessageItem, inboxId: string): boolean {
  return (
    message.inboxId === inboxId &&
    message.labels.some((label) => label.toLocaleLowerCase("en-US") === "received")
  );
}

async function persistCursor(params: {
  store: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  key: string;
  baselineAtMs: number;
  highWaterAtMs: number;
  established: boolean;
}): Promise<void> {
  const update = params.store.update;
  if (update) {
    await update(params.key, (currentValue) => {
      const current = normalizeCursor(currentValue);
      return {
        version: CURSOR_VERSION,
        baselineAtMs: current?.baselineAtMs ?? params.baselineAtMs,
        highWaterAtMs: Math.max(current?.highWaterAtMs ?? 0, params.highWaterAtMs),
        established: current?.established === true || params.established,
      };
    });
    return;
  }
  const current = normalizeCursor(await params.store.lookup(params.key));
  await params.store.register(params.key, {
    version: CURSOR_VERSION,
    baselineAtMs: current?.baselineAtMs ?? params.baselineAtMs,
    highWaterAtMs: Math.max(current?.highWaterAtMs ?? 0, params.highWaterAtMs),
    established: current?.established === true || params.established,
  });
}

export async function createAgentMailCatchUpSession(params: {
  account: ResolvedAgentMailAccount;
  client?: AgentMailClient;
  store?: PluginStateKeyedStore<AgentMailCatchUpCursor>;
  now?: () => number;
  log?: AgentMailCatchUpLog;
}): Promise<AgentMailCatchUpSession> {
  const now = params.now ?? Date.now;
  const store =
    params.store ??
    getAgentMailRuntime().state.openKeyedStore<AgentMailCatchUpCursor>({
      namespace: AGENTMAIL_REST_CATCH_UP_NAMESPACE,
      maxEntries: AGENTMAIL_REST_CATCH_UP_MAX_ACCOUNTS,
      overflowPolicy: "reject-new",
    });
  const key = cursorKey(params.account);
  const initialAtMs = now();
  const initialCursor: AgentMailCatchUpCursor = {
    version: CURSOR_VERSION,
    baselineAtMs: initialAtMs,
    highWaterAtMs: initialAtMs,
    established: false,
  };
  await store.registerIfAbsent(key, initialCursor);
  const client = params.client ?? createAgentMailClient(params.account);

  return {
    run: async ({ receive, abortSignal }) => {
      const storedCursor = normalizeCursor(await store.lookup(key));
      if (!storedCursor) {
        throw new Error("AgentMail WebSocket catch-up cursor is unavailable");
      }
      const afterMs = storedCursor.established
        ? Math.max(0, storedCursor.highWaterAtMs - AGENTMAIL_REST_CATCH_UP_OVERLAP_MS)
        : storedCursor.baselineAtMs;
      let highWaterAtMs = storedCursor.highWaterAtMs;
      let pageCursor: string | undefined;
      let admitted = 0;
      do {
        const page = await client.inboxes.messages.list(
          params.account.inboxId,
          {
            limit: PAGE_LIMIT,
            ...(pageCursor ? { pageToken: pageCursor } : {}),
            labels: ["received"],
            after: new Date(afterMs),
            ascending: true,
            includeSpam: false,
            includeBlocked: false,
            includeUnauthenticated: false,
            includeTrash: false,
          },
          { abortSignal },
        );
        let pageAdvanced = false;
        for (const message of page.messages) {
          if (abortSignal.aborted) {
            return;
          }
          if (!isReceivedMessage(message, params.account.inboxId)) {
            continue;
          }
          await receive({
            accountId: params.account.accountId,
            inboxId: params.account.inboxId,
            messageId: message.messageId,
            transport: "rest",
            receivedAt: message.timestamp.getTime(),
          });
          admitted += 1;
          highWaterAtMs = Math.max(highWaterAtMs, message.timestamp.getTime());
          pageAdvanced = true;
        }
        if (pageAdvanced) {
          // Persist once per page. If admission fails mid-page, the cursor stays behind the page
          // and durable message-id dedupe safely absorbs the repeated prefix on the next pass.
          await persistCursor({
            store,
            key,
            baselineAtMs: storedCursor.baselineAtMs,
            highWaterAtMs,
            established: false,
          });
        }
        pageCursor = page.nextPageToken;
      } while (pageCursor && !abortSignal.aborted);

      if (abortSignal.aborted) {
        return;
      }
      await persistCursor({
        store,
        key,
        baselineAtMs: storedCursor.baselineAtMs,
        highWaterAtMs,
        established: true,
      });
      if (admitted > 0) {
        params.log?.info?.(
          `AgentMail WebSocket catch-up admitted ${admitted} message${admitted === 1 ? "" : "s"} for account ${params.account.accountId}`,
        );
      }
    },
  };
}
