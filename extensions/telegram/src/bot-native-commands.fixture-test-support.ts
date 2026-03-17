import { vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

export type NativeCommandTestParams = {
  bot: {
    api: {
      setMyCommands: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
    };
    command: ReturnType<typeof vi.fn>;
  };
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  replyToMode: string;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: () => { allowlistEnabled: boolean; allowed: boolean };
  resolveTelegramGroupConfig: () => {
    groupConfig: undefined;
    topicConfig: undefined;
  };
  shouldSkipUpdate: () => boolean;
  opts: { token: string };
};

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function createNativeCommandTestParams(
  params: Partial<NativeCommandTestParams> = {},
): NativeCommandTestParams {
  const log = vi.fn();
  return {
    bot:
      params.bot ??
      ({
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as NativeCommandTestParams["bot"]),
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime: params.runtime ?? ({ log } as RuntimeEnv),
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    replyToMode: params.replyToMode ?? "off",
    textLimit: params.textLimit ?? 4000,
    useAccessGroups: params.useAccessGroups ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    resolveGroupPolicy:
      params.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ReturnType<NativeCommandTestParams["resolveGroupPolicy"]>),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({ groupConfig: undefined, topicConfig: undefined })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    opts: params.opts ?? { token: "token" },
  };
}

export function createTelegramPrivateCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 1,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: { id: params?.chatId ?? 100, type: "private" as const },
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramTopicCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  threadId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
        is_forum: true,
      },
      message_thread_id: params?.threadId ?? 42,
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}
