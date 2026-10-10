import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import { formatIMessageChatTarget, type IMessageService, parseIMessageTarget } from "./targets.js";

type ChatActionOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  account?: ResolvedIMessageAccount;
  client?: IMessageRpcClient;
  cliPath?: string;
  dbPath?: string;
  remoteHost?: string;
  service?: IMessageService;
  timeoutMs?: number;
  chatId?: number;
};

async function runChatAction(
  method: "typing" | "read",
  to: string,
  opts: ChatActionOpts,
  isTyping?: boolean,
): Promise<void> {
  const cfg = requireRuntimeConfig(opts.cfg, "iMessage chat action");
  const account = opts.account ?? resolveIMessageAccount({ cfg, accountId: opts.accountId });
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const params: Record<string, unknown> = {};
  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }
  if (method === "typing") {
    params.typing = isTyping;
    const service =
      opts.service ??
      (target.kind === "handle" ? target.service : undefined) ??
      account.config.service;
    if (service) {
      params.service = service;
    }
  }
  const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
  const remoteHost = await resolveIMessageRemoteHost({
    cliPath,
    remoteHost: opts.remoteHost ?? account.config.remoteHost,
  });
  const client = opts.client ?? (await createIMessageRpcClient({ cliPath, dbPath, remoteHost }));
  const shouldClose = !opts.client;
  try {
    await client.request(method, params, { timeoutMs: opts.timeoutMs });
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}

export async function sendIMessageTyping(
  to: string,
  isTyping: boolean,
  opts: ChatActionOpts,
): Promise<void> {
  await runChatAction("typing", to, opts, isTyping);
}

export async function markIMessageChatRead(to: string, opts: ChatActionOpts): Promise<void> {
  await runChatAction("read", to, opts);
}
