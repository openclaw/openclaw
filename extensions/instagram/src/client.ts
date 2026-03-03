import path from "node:path";
import process from "node:process";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import { normalizeInstagramMessagingTarget, normalizeInstagramUsername } from "./normalize.js";
import { getInstagramRuntime } from "./runtime.js";
import type { InstagramMessage, InstagramProbe, InstagramThread, ResolvedInstagramAccount } from "./types.js";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
  meta?: Record<string, unknown>;
};

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseInstagramEnvelope<T>(stdout: string): Envelope<T> {
  const cleaned = stripAnsi(stdout).trim();
  const lines = cleaned
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as Envelope<T>;
    } catch {
      // Keep scanning backwards; Ink-based CLIs can emit intermediate frames.
    }
  }
  return JSON.parse(cleaned) as Envelope<T>;
}

function buildInstagramCliArgv(
  account: ResolvedInstagramAccount,
  args: string[],
): string[] {
  const cliPath = account.cliPath.trim();
  const cliArgs = account.cliArgs ?? [];
  if (/\.(mjs|cjs|js|ts|mts|cts)$/i.test(path.basename(cliPath))) {
    return [process.execPath, cliPath, ...cliArgs, ...args];
  }
  return [cliPath, ...cliArgs, ...args];
}

async function runInstagramCli<T>(params: {
  account: ResolvedInstagramAccount;
  args: string[];
  timeoutMs?: number;
}): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const argv = buildInstagramCliArgv(params.account, params.args);
  const result = await runPluginCommandWithTimeout({
    argv,
    cwd: params.account.cwd,
    timeoutMs: params.timeoutMs ?? 60_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `command failed: ${argv[0]}`);
  }
  let parsed: Envelope<T>;
  try {
    parsed = parseInstagramEnvelope<T>(result.stdout);
  } catch (error) {
    throw new Error(
      `instagram-cli returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed.ok) {
    throw new Error(parsed.error?.message || parsed.error?.code || "instagram-cli returned error");
  }
  if (parsed.data === undefined) {
    throw new Error("instagram-cli returned no data");
  }
  return {
    data: parsed.data,
    meta: parsed.meta,
  };
}

function withSessionUsername(account: ResolvedInstagramAccount, args: string[]): string[] {
  return account.sessionUsername ? [...args, account.sessionUsername] : args;
}

export async function listInstagramThreads(
  account: ResolvedInstagramAccount,
  options?: { limit?: number },
): Promise<InstagramThread[]> {
  const fields = "id,title,unread,lastActivity,usernames,lastMessageText";
  const { data } = await runInstagramCli<InstagramThread[]>({
    account,
    args: withSessionUsername(account, [
      "llm",
      "threads",
      "--limit",
      String(options?.limit ?? 100),
      "--fields",
      fields,
    ]),
  });
  return data.map((thread) => ({
    id: String(thread.id),
    title: thread.title,
    usernames: Array.isArray(thread.usernames)
      ? thread.usernames.map((entry) => normalizeInstagramUsername(String(entry))).filter(Boolean)
      : [],
    unread: Boolean(thread.unread),
    lastActivity: thread.lastActivity,
    lastMessageText: thread.lastMessageText,
  }));
}

export async function listInstagramMessages(
  account: ResolvedInstagramAccount,
  params: { threadId: string; limit?: number; cursor?: string; since?: string },
): Promise<{ messages: InstagramMessage[]; cursor?: string }> {
  const fields = "id,threadId,username,itemType,isOutgoing,timestamp,text";
  const args = [
    "llm",
    "messages",
    params.threadId,
    "--limit",
    String(params.limit ?? 50),
    "--fields",
    fields,
  ];
  if (params.cursor) {
    args.push("--cursor", params.cursor);
  }
  if (params.since) {
    args.push("--since", params.since);
  }
  const { data, meta } = await runInstagramCli<InstagramMessage[]>({
    account,
    args: withSessionUsername(account, args),
  });
  const cursor = typeof meta?.cursor === "string" && meta.cursor.trim() ? meta.cursor : undefined;
  return {
    messages: data.map((message) => ({
      id: String(message.id),
      threadId: String(message.threadId),
      username: message.username ? normalizeInstagramUsername(String(message.username)) : undefined,
      itemType: message.itemType,
      isOutgoing: Boolean(message.isOutgoing),
      timestamp: message.timestamp,
      text: message.text,
    })),
    cursor,
  };
}

export async function sendMessageInstagram(
  target: string,
  text: string,
  options: { account: ResolvedInstagramAccount; idempotencyKey?: string },
): Promise<{ messageId: string; target: string }> {
  const resolvedThreadId = await resolveInstagramThreadId(options.account, target);
  const args = ["llm", "send", resolvedThreadId, text];
  if (options.idempotencyKey) {
    args.push("--idempotency-key", options.idempotencyKey);
  }
  await runInstagramCli({
    account: options.account,
    args: withSessionUsername(options.account, args),
  });
  getInstagramRuntime().channel.activity.record({
    channel: "instagram",
    accountId: options.account.accountId,
    direction: "outbound",
  });
  return {
    messageId: `instagram:${Date.now()}`,
    target: resolvedThreadId,
  };
}

export async function markInstagramThreadRead(
  account: ResolvedInstagramAccount,
  threadId: string,
  itemId: string,
): Promise<void> {
  await runInstagramCli({
    account,
    args: withSessionUsername(account, ["llm", "mark-read", threadId, itemId]),
  });
}

export async function probeInstagram(
  account: ResolvedInstagramAccount,
  timeoutMs = 20_000,
): Promise<InstagramProbe> {
  try {
    const threads = await listInstagramThreads(account, { limit: 1 });
    return {
      ok: true,
      value: account.sessionUsername ?? account.cliPath,
      cliPath: account.cliPath,
      sessionUsername: account.sessionUsername,
      threadCount: threads.length,
    };
  } catch (error) {
    return {
      ok: false,
      value: account.sessionUsername ?? account.cliPath,
      cliPath: account.cliPath,
      sessionUsername: account.sessionUsername,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: timeoutMs,
    };
  }
}

export async function resolveInstagramThreadId(
  account: ResolvedInstagramAccount,
  target: string,
): Promise<string> {
  const normalized = normalizeInstagramMessagingTarget(target);
  if (!normalized) {
    throw new Error(`invalid Instagram target: ${target}`);
  }
  if (normalized.startsWith("thread:")) {
    return normalized.slice("thread:".length);
  }
  const username = normalized.slice("user:".length);
  const threads = await listInstagramThreads(account, { limit: 100 });
  const match = threads.find((thread) => thread.usernames.includes(username));
  if (!match) {
    throw new Error(`could not resolve Instagram thread for @${username}`);
  }
  return match.id;
}

export async function resolveInstagramTargets(params: {
  account: ResolvedInstagramAccount;
  inputs: string[];
  kind: "peer" | "group";
}): Promise<
  Array<{ input: string; resolved: boolean; id?: string; name?: string; note?: string }>
> {
  const threads = await listInstagramThreads(params.account, { limit: 100 });
  return params.inputs.map((input) => {
    const normalized = normalizeInstagramMessagingTarget(input);
    if (!normalized) {
      return { input, resolved: false, note: "invalid Instagram target" };
    }
    if (normalized.startsWith("thread:")) {
      const threadId = normalized.slice("thread:".length);
      const thread = threads.find((entry) => entry.id === threadId);
      const isGroup = (thread?.usernames.length ?? 0) > 1;
      if (params.kind === "group" && !isGroup) {
        return { input, resolved: false, note: "expected group thread" };
      }
      if (params.kind === "peer" && isGroup) {
        return { input, resolved: false, note: "expected direct thread" };
      }
      return {
        input,
        resolved: true,
        id: threadId,
        name: thread?.title || thread?.usernames.join(", ") || threadId,
      };
    }
    const username = normalized.slice("user:".length);
    const thread = threads.find((entry) => entry.usernames.includes(username));
    if (!thread) {
      return { input, resolved: false, note: `no thread found for @${username}` };
    }
    const isGroup = thread.usernames.length > 1;
    if (params.kind === "group" && !isGroup) {
      return { input, resolved: false, note: "expected group thread" };
    }
    if (params.kind === "peer" && isGroup) {
      return { input, resolved: false, note: "expected direct thread" };
    }
    return {
      input,
      resolved: true,
      id: thread.id,
      name: thread.title || `@${username}`,
    };
  });
}

export const __testing = {
  buildInstagramCliArgv,
};
