import type { WorkboardKeyedStore } from "../persistence-types.js";
import { createWorkboardSqliteKernel } from "../sqlite-store-kernel.js";
import type { createWorkboardSqliteStores } from "../sqlite-store.js";

// Native statement counts and error ordering stay with the synchronous worker kernel.
function asyncKeyedStore<T>(store: {
  register(key: string, value: T): void;
  lookup(key: string): T | undefined;
  delete(key: string): boolean;
  entries(): Array<{ key: string; value: T }>;
}): WorkboardKeyedStore<T> {
  return {
    register: async (key, value) => store.register(key, value),
    lookup: async (key) => store.lookup(key),
    delete: async (key) => store.delete(key),
    entries: async () => store.entries(),
  };
}

export function createKernelStores(dbPath: string): ReturnType<typeof createWorkboardSqliteStores> {
  const kernel = createWorkboardSqliteKernel(dbPath);
  return {
    ready: Promise.resolve(kernel.dataVersion()),
    dataVersion: async () => kernel.dataVersion(),
    close: async () => kernel.close(),
    cards: {
      ...asyncKeyedStore(kernel.cards),
      entries: async (boardId) => kernel.cards.entries(boardId),
      registerIfAbsent: async (...args) => kernel.cards.registerIfAbsent(...args),
      registerIfUpdatedAt: async (...args) => kernel.cards.registerIfUpdatedAt(...args),
      claimIfOwnerAvailable: async (...args) => kernel.cards.claimIfOwnerAvailable(...args),
      deleteIfUpdatedAt: async (...args) => kernel.cards.deleteIfUpdatedAt(...args),
      listCardStatuses: async (ids) => kernel.cards.listCardStatuses(ids),
      listBoardAggregates: async () => kernel.cards.listBoardAggregates(),
      listStatsAggregates: async (boardId) => kernel.cards.listStatsAggregates(boardId),
      hasCards: async (boardId) => kernel.cards.hasCards(boardId),
    },
    boards: asyncKeyedStore(kernel.boards),
    subscriptions: asyncKeyedStore(kernel.subscriptions),
    attachments: asyncKeyedStore(kernel.attachments),
  };
}
