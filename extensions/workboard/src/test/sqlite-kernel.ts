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

export function createKernelStores(
  dbPath: string,
): Omit<ReturnType<typeof createWorkboardSqliteStores>, "runWithWriteAuthority"> {
  const kernel = createWorkboardSqliteKernel(dbPath);
  return {
    ready: Promise.resolve(kernel.dataVersion()),
    dataVersion: async () => kernel.dataVersion(),
    close: async () => kernel.close(),
    cards: {
      ...asyncKeyedStore(kernel.cards),
      entries: async (scope) => kernel.cards.entries(scope),
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
    sessionsBoard: {
      get: async (boardId) => kernel.sessionsBoard.get(boardId),
      update: async (boardId, patch) => kernel.sessionsBoard.update(boardId, patch),
      listPlacements: async (boardId) => kernel.sessionsBoard.listPlacements(boardId),
      repairPlacements: async () => kernel.sessionsBoard.repairPlacements(),
      writePlacement: async (...args) => kernel.sessionsBoard.writePlacement(...args),
    },
    subscriptions: asyncKeyedStore(kernel.subscriptions),
    attachments: asyncKeyedStore(kernel.attachments),
  };
}
