import { fileURLToPath } from "node:url";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardKeyedStore,
} from "./src/persistence-types.js";

const MAX_CARDS = 2000;

function migrationEnv(params: { env: NodeJS.ProcessEnv; stateDir: string }): NodeJS.ProcessEnv {
  return { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
}

function openLegacyStores(context: PluginDoctorStateMigrationContext, env: NodeJS.ProcessEnv) {
  return {
    cards: context.openPluginStateKeyedStore<PersistedWorkboardCard>({
      namespace: "workboard.cards",
      maxEntries: MAX_CARDS,
      env,
    }),
    boards: context.openPluginStateKeyedStore<PersistedWorkboardBoard>({
      namespace: "workboard.boards",
      maxEntries: 200,
      env,
    }),
    subscriptions: context.openPluginStateKeyedStore<PersistedWorkboardNotificationSubscription>({
      namespace: "workboard.notify",
      maxEntries: 2000,
      env,
    }),
    attachments: context.openPluginStateKeyedStore<PersistedWorkboardAttachment>({
      namespace: "workboard.attachments",
      maxEntries: MAX_CARDS * 21,
      env,
    }),
  };
}

function isPersistedCard(value: unknown): value is PersistedWorkboardCard {
  return Boolean(
    value && typeof value === "object" && (value as PersistedWorkboardCard).version === 1,
  );
}

function isPersistedBoard(value: unknown): value is PersistedWorkboardBoard {
  return Boolean(
    value && typeof value === "object" && (value as PersistedWorkboardBoard).version === 1,
  );
}

function isPersistedSubscription(
  value: unknown,
): value is PersistedWorkboardNotificationSubscription {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as PersistedWorkboardNotificationSubscription).version === 1,
  );
}

function isPersistedAttachment(value: unknown): value is PersistedWorkboardAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    version?: unknown;
    attachment?: Partial<PersistedWorkboardAttachment["attachment"]>;
    contentBase64?: unknown;
  };
  const attachment = candidate.attachment;
  return (
    candidate.version === 1 &&
    attachment != null &&
    typeof attachment === "object" &&
    typeof attachment.id === "string" &&
    typeof attachment.cardId === "string" &&
    typeof attachment.fileName === "string" &&
    typeof attachment.byteSize === "number" &&
    typeof attachment.createdAt === "number" &&
    typeof candidate.contentBase64 === "string"
  );
}

async function migrateNamespace<T>(params: {
  label: string;
  legacy: WorkboardKeyedStore<T>;
  target: WorkboardKeyedStore<T>;
  isValid: (value: unknown) => value is T;
}): Promise<{ imported: number; warnings: string[] }> {
  const warnings: string[] = [];
  let imported = 0;
  for (const entry of await params.legacy.entries()) {
    if (!params.isValid(entry.value)) {
      warnings.push(`Skipped malformed legacy Workboard ${params.label} entry ${entry.key}`);
      continue;
    }
    try {
      const targetEntry = await params.target.lookup(entry.key);
      if (targetEntry) {
        if (JSON.stringify(targetEntry) === JSON.stringify(entry.value)) {
          await params.legacy.delete(entry.key);
          imported++;
          continue;
        }
        warnings.push(
          `Skipped legacy Workboard ${params.label} entry ${entry.key} because the SQLite target already exists`,
        );
        continue;
      }
      await params.target.register(entry.key, entry.value);
      await params.legacy.delete(entry.key);
      imported++;
    } catch (err) {
      warnings.push(
        `Failed migrating legacy Workboard ${params.label} entry ${entry.key}: ${String(err)}`,
      );
    }
  }
  return { imported, warnings };
}

async function targetCardReferencesAttachment(
  cards: WorkboardKeyedStore,
  attachment: PersistedWorkboardAttachment,
): Promise<boolean> {
  const card = await cards.lookup(attachment.attachment.cardId);
  return Boolean(
    card?.version === 1 &&
    card.card.metadata?.attachments?.some(
      (entry) =>
        entry.id === attachment.attachment.id && entry.cardId === attachment.attachment.cardId,
    ),
  );
}

async function migrateAttachments(params: {
  legacy: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  cards: WorkboardKeyedStore;
  target: WorkboardKeyedStore<PersistedWorkboardAttachment>;
}): Promise<{ imported: number; warnings: string[] }> {
  const warnings: string[] = [];
  let imported = 0;
  for (const entry of await params.legacy.entries()) {
    if (!isPersistedAttachment(entry.value)) {
      warnings.push(`Skipped malformed legacy Workboard attachment entry ${entry.key}`);
      continue;
    }
    if (!(await targetCardReferencesAttachment(params.cards, entry.value))) {
      warnings.push(
        `Skipped legacy Workboard attachment entry ${entry.key} because its owning card was not migrated or does not reference the attachment`,
      );
      continue;
    }
    const targetEntry = await params.target.lookup(entry.key);
    if (targetEntry) {
      if (JSON.stringify(targetEntry) === JSON.stringify(entry.value)) {
        await params.legacy.delete(entry.key);
        imported++;
        continue;
      }
      warnings.push(
        `Skipped legacy Workboard attachment entry ${entry.key} because the SQLite target already exists`,
      );
      continue;
    }
    try {
      await params.target.register(entry.key, entry.value);
      await params.legacy.delete(entry.key);
      imported++;
    } catch (err) {
      warnings.push(
        `Failed migrating legacy Workboard attachment entry ${entry.key}: ${String(err)}`,
      );
    }
  }
  return { imported, warnings };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "workboard-28-kv-to-sqlite",
    label: "Workboard .28 plugin-state KV",
    async detectLegacyState(params) {
      const env = migrationEnv(params);
      const { cards, boards, subscriptions, attachments } = openLegacyStores(params.context, env);
      let count = 0;
      for (const store of [cards, boards, subscriptions, attachments]) {
        count += store.count ? await store.count() : (await store.entries()).length;
      }
      if (count === 0) {
        return null;
      }
      // Empty legacy namespaces need no SQLite runtime. Resolve the target only
      // when there is state to preview and migrate.
      const { resolveWorkboardSqlitePath } = await import("./src/sqlite-store-paths.js");
      return {
        preview: [
          `- Workboard: ${count} legacy .28 plugin-state KV ${count === 1 ? "entry" : "entries"} → ${resolveWorkboardSqlitePath(env)}`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const { createWorkboardSqliteStores } = await import("./src/sqlite-store.js");
      const { resolveWorkboardSqliteWorkerModuleUrl } = await import("./src/sqlite-store-paths.js");
      const env = migrationEnv(params);
      const { cards, boards, subscriptions, attachments } = openLegacyStores(params.context, env);
      const sqlite = createWorkboardSqliteStores({
        env,
        workerModuleUrl: resolveWorkboardSqliteWorkerModuleUrl(fileURLToPath(import.meta.url)),
      });
      try {
        const cardResult = await migrateNamespace({
          label: "card",
          legacy: cards,
          target: sqlite.cards,
          isValid: isPersistedCard,
        });
        const boardResult = await migrateNamespace({
          label: "board",
          legacy: boards,
          target: sqlite.boards,
          isValid: isPersistedBoard,
        });
        const subscriptionResult = await migrateNamespace({
          label: "notification subscription",
          legacy: subscriptions,
          target: sqlite.subscriptions,
          isValid: isPersistedSubscription,
        });
        const attachmentResult = await migrateAttachments({
          legacy: attachments,
          cards: sqlite.cards,
          target: sqlite.attachments,
        });
        const imported =
          cardResult.imported +
          boardResult.imported +
          subscriptionResult.imported +
          attachmentResult.imported;
        return {
          changes:
            imported > 0
              ? [
                  `Migrated ${imported} Workboard .28 plugin-state KV ${imported === 1 ? "entry" : "entries"} → relational SQLite`,
                ]
              : [],
          warnings: [
            ...cardResult.warnings,
            ...boardResult.warnings,
            ...subscriptionResult.warnings,
            ...attachmentResult.warnings,
          ],
        };
      } finally {
        await sqlite.close();
      }
    },
  },
];
