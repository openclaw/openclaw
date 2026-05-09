import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  importTelegramMessageCacheEntries,
  resolveTelegramMessageCacheScopeKey,
} from "./message-cache.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { cacheSticker, type CachedSticker } from "./sticker-cache-store.js";
import { type TelegramThreadBindingRecord } from "./thread-bindings.js";
import { resolveTopicNameCacheScope, updateTopicName } from "./topic-name-cache.js";
import { writeTelegramUpdateOffset } from "./update-offset-store.js";

type DetectParams = { stateDir: string };

const THREAD_BINDING_STORE = createPluginStateSyncKeyedStore<TelegramThreadBindingRecord>(
  "telegram",
  {
    namespace: "thread-bindings",
    maxEntries: 50_000,
  },
);

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function removeFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

function telegramDir(stateDir: string): string {
  return path.join(stateDir, "telegram");
}

function hashPart(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function threadBindingKey(accountId: string, conversationId: string): string {
  return `${hashPart(accountId)}:${hashPart(conversationId)}`;
}

function customPlan(params: {
  label: string;
  sourcePath: string;
  apply: Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>["apply"];
}): Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }> {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    apply: params.apply,
  };
}

function updateOffsetPlans(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  const dir = telegramDir(stateDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => /^update-offset-.+\.json$/u.test(name))
    .map((name) => {
      const sourcePath = path.join(dir, name);
      const accountId = name.replace(/^update-offset-/u, "").replace(/\.json$/u, "");
      return customPlan({
        label: "Telegram update offset",
        sourcePath,
        apply: async () => {
          const parsed = readJson(sourcePath) as { lastUpdateId?: unknown; botId?: unknown };
          if (typeof parsed.lastUpdateId === "number") {
            await writeTelegramUpdateOffset({
              accountId,
              updateId: parsed.lastUpdateId,
              botToken: typeof parsed.botId === "string" ? `${parsed.botId}:token` : undefined,
            });
          }
          removeFile(sourcePath);
          return { changes: ["Imported 1 Telegram update offset"], warnings: [] };
        },
      });
    });
}

function stickerCachePlan(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  const sourcePath = path.join(telegramDir(stateDir), "sticker-cache.json");
  if (!fs.existsSync(sourcePath)) {
    return [];
  }
  return [
    customPlan({
      label: "Telegram sticker cache",
      sourcePath,
      apply: () => {
        const parsed = readJson(sourcePath) as { stickers?: Record<string, CachedSticker> };
        let imported = 0;
        for (const sticker of Object.values(parsed.stickers ?? {})) {
          if (sticker?.fileUniqueId && sticker.description && sticker.cachedAt) {
            cacheSticker(sticker);
            imported += 1;
          }
        }
        removeFile(sourcePath);
        return { changes: [`Imported ${imported} Telegram sticker cache`], warnings: [] };
      },
    }),
  ];
}

function threadBindingPlans(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  const dir = telegramDir(stateDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => /^thread-bindings-.+\.json$/u.test(name))
    .map((name) => {
      const sourcePath = path.join(dir, name);
      const accountId = name.replace(/^thread-bindings-/u, "").replace(/\.json$/u, "");
      return customPlan({
        label: "Telegram thread bindings",
        sourcePath,
        apply: () => {
          const parsed = readJson(sourcePath) as {
            bindings?: Array<Partial<TelegramThreadBindingRecord>>;
          };
          let imported = 0;
          for (const binding of parsed.bindings ?? []) {
            if (!binding.conversationId || !binding.targetSessionKey) {
              continue;
            }
            const record: TelegramThreadBindingRecord = {
              accountId,
              conversationId: binding.conversationId,
              targetKind: binding.targetKind === "acp" ? "acp" : "subagent",
              targetSessionKey: binding.targetSessionKey,
              boundAt: typeof binding.boundAt === "number" ? binding.boundAt : Date.now(),
              lastActivityAt:
                typeof binding.lastActivityAt === "number" ? binding.lastActivityAt : Date.now(),
              ...(typeof binding.agentId === "string" ? { agentId: binding.agentId } : {}),
              ...(typeof binding.boundBy === "string" ? { boundBy: binding.boundBy } : {}),
            };
            THREAD_BINDING_STORE.register(
              threadBindingKey(accountId, record.conversationId),
              record,
            );
            imported += 1;
          }
          removeFile(sourcePath);
          return { changes: [`Imported ${imported} Telegram thread bindings`], warnings: [] };
        },
      });
    });
}

function sentMessagePlans(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  return fs.globSync(path.join(stateDir, "**/*.telegram-sent-messages.json")).map((sourcePath) =>
    customPlan({
      label: "Telegram sent-message cache",
      sourcePath,
      apply: () => {
        const parsed = readJson(sourcePath) as Record<string, Record<string, number>>;
        let imported = 0;
        for (const [chatId, messages] of Object.entries(parsed)) {
          for (const messageId of Object.keys(messages)) {
            recordSentMessage(chatId, Number(messageId), { accountId: "default" });
            imported += 1;
          }
        }
        removeFile(sourcePath);
        return { changes: [`Imported ${imported} Telegram sent-message cache`], warnings: [] };
      },
    }),
  );
}

function messageCachePlans(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  return fs.globSync(path.join(stateDir, "**/*.telegram-messages.json")).map((sourcePath) =>
    customPlan({
      label: "Telegram message cache",
      sourcePath,
      apply: () => {
        const parsed = readJson(sourcePath);
        const legacyStorePath = sourcePath.replace(/\.telegram-messages\.json$/u, "");
        const imported = importTelegramMessageCacheEntries(
          resolveTelegramMessageCacheScopeKey(legacyStorePath),
          parsed,
        );
        removeFile(sourcePath);
        return { changes: [`Imported ${imported} Telegram message cache`], warnings: [] };
      },
    }),
  );
}

function topicNamePlans(
  stateDir: string,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  return fs.globSync(path.join(stateDir, "**/*.telegram-topic-names.json")).map((sourcePath) =>
    customPlan({
      label: "Telegram topic-name cache",
      sourcePath,
      apply: () => {
        const parsed = readJson(sourcePath) as Record<
          string,
          { name?: string; iconColor?: number; updatedAt?: number }
        >;
        const legacyStorePath = sourcePath.replace(/\.telegram-topic-names\.json$/u, "");
        const topicScope = resolveTopicNameCacheScope(legacyStorePath);
        let imported = 0;
        for (const [key, entry] of Object.entries(parsed)) {
          const [chatId, threadId] = key.split(":", 2);
          if (!chatId || !threadId || !entry.name) {
            continue;
          }
          updateTopicName(chatId, threadId, entry, topicScope);
          imported += 1;
        }
        removeFile(sourcePath);
        return { changes: [`Imported ${imported} Telegram topic-name cache`], warnings: [] };
      },
    }),
  );
}

export function detectTelegramLegacyStateMigrations(
  params: DetectParams,
): Array<Extract<ChannelLegacyStateMigrationPlan, { kind: "custom" }>> {
  return [
    ...updateOffsetPlans(params.stateDir),
    ...stickerCachePlan(params.stateDir),
    ...threadBindingPlans(params.stateDir),
    ...sentMessagePlans(params.stateDir),
    ...messageCachePlans(params.stateDir),
    ...topicNamePlans(params.stateDir),
  ];
}
