// MTProto client for managed bots (OP-167, Phase 1).
// Split-session contract (same as mtproto-managed-bots.ts):
//   - bots.checkUsername + bots.createBot run on a USER session
//   - bots.exportBotToken runs on the MANAGER-BOT session
//
// This module owns no transport dependency: gramjs (`telegram` npm package)
// is loaded via dynamic import only when connect() is called, so unit tests
// and installs without MTProto credentials pay no cost. Callers inject an
// `invoke` function, which keeps this module testable without a live session.

import type { ManagedBotCreator, ManagedBotTokenExporter } from "./mtproto-managed-bots.js";

export type MtprotoInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type MtprotoSessionParams = {
  apiId: number;
  apiHash: string;
  /** Serialized StringSession for the user (creator) or bot (exporter) session. */
  session: string;
};

/** Build a creator backed by a user MTProto session. */
export function createMtprotoBotCreator(invoke: MtprotoInvoke): ManagedBotCreator {
  return {
    async checkUsername(username: string): Promise<boolean> {
      const res = (await invoke("bots.checkUsername", { username })) as
        | { available?: boolean }
        | boolean;
      return typeof res === "boolean" ? res : (res.available ?? false);
    },
    async createBot(params: { name: string; username: string }): Promise<{ botId: string }> {
      const res = (await invoke("bots.createBot", {
        name: params.name,
        username: params.username,
      })) as { botId?: string; bot_id?: string; id?: string };
      const botId = res.botId ?? res.bot_id ?? res.id;
      if (!botId) {
        throw new Error("BOT_INVALID: createBot response missing bot id");
      }
      return { botId: String(botId) };
    },
  };
}

/** Build a token exporter backed by the manager-bot MTProto session. */
export function createMtprotoTokenExporter(invoke: MtprotoInvoke): ManagedBotTokenExporter {
  return {
    async exportBotToken(params: { botId: string; revoke: boolean }): Promise<{ token: string }> {
      const res = (await invoke("bots.exportBotToken", {
        bot_id: params.botId,
        revoke: params.revoke,
      })) as { token?: string };
      if (!res.token) {
        throw new Error("BOT_INVALID: exportBotToken response missing token");
      }
      return { token: res.token };
    },
  };
}

/**
 * Connect a gramjs StringSession and return an `invoke` bound to it.
 * The `telegram` package must be installed by the operator; it stays an
 * optional peer so the plugin loads without MTProto credentials.
 */
export async function connectMtprotoSession(params: MtprotoSessionParams): Promise<{
  invoke: MtprotoInvoke;
  disconnect: () => Promise<void>;
}> {
  // Optional peer: loaded by name (not a literal) so the plugin compiles
  // and loads without the gramjs package installed.
  const TELEGRAM_PACKAGE = "telegram";
  const mod = (await import(/* @vite-ignore */ TELEGRAM_PACKAGE)) as unknown as Record<
    string,
    unknown
  >;
  type GramjsClient = {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    invoke: (request: unknown) => Promise<unknown>;
  };
  type TelegramClientCtor = new (
    session: unknown,
    apiId: number,
    apiHash: string,
    opts?: Record<string, unknown>,
  ) => GramjsClient;
  type StringSessionCtor = new (session: string) => unknown;
  const TelegramClient = (mod["TelegramClient"] ??
    (mod["default"] as Record<string, unknown>)?.["TelegramClient"]) as
    | TelegramClientCtor
    | undefined;
  const StringSession = (mod["StringSession"] ??
    (mod["default"] as Record<string, unknown>)?.["StringSession"]) as
    | StringSessionCtor
    | undefined;
  if (!TelegramClient || !StringSession) {
    throw new Error("MTProto unavailable: install the optional 'telegram' (gramjs) package");
  }
  const client = new TelegramClient(
    new StringSession(params.session),
    params.apiId,
    params.apiHash,
    {
      connectionRetries: 3,
    },
  );
  await client.connect();
  return {
    invoke: async (method: string, p: Record<string, unknown>) =>
      client.invoke({ _: method, ...p }),
    disconnect: async () => {
      await client.disconnect();
    },
  };
}
