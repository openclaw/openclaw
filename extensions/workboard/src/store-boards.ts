import type {
  WorkboardBoardMetadata,
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardCardCursor,
  WorkboardChange,
  WorkboardListResult,
  WorkboardSessionPlacement,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { redactClaimToken } from "./card-redaction.js";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSessionPlacementWrite,
  WorkboardSessionsBoardStore,
  WorkboardSubscriptionStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";
import { normalizeBoardMetadata } from "./store-board-normalizers.js";
import { compareCards } from "./store-card-helpers.js";
import type { WorkboardBoardInput, WorkboardListOptions } from "./store-inputs.js";
import { normalizeBoardId, normalizeBoardIdRequired } from "./store-normalizers.js";
import { readCards } from "./store-read.js";
import { WorkboardStoreRuntime } from "./store-runtime.js";

function emptyBoardSummary(id: string): WorkboardBoardSummary {
  return { id, total: 0, active: 0, archived: 0, byStatus: {} };
}

export class WorkboardBoardStore extends WorkboardStoreRuntime {
  protected readonly store: WorkboardCardStore;
  protected readonly boardStore: WorkboardKeyedStore<PersistedWorkboardBoard>;
  protected readonly subscriptionStore: WorkboardSubscriptionStore;
  protected readonly attachmentStore: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  private readonly sessionsBoardStore: WorkboardSessionsBoardStore;

  constructor(
    store: WorkboardCardStore,
    stores: {
      boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
      sessionsBoard: WorkboardSessionsBoardStore;
      subscriptions: WorkboardSubscriptionStore;
      attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
      ready?: Promise<void>;
      close?: () => void | Promise<void>;
      runWithWriteAuthority?: WorkboardWriteAuthority;
      readWriteToken?: () => string | undefined;
    },
  ) {
    super(stores.close, stores.ready, stores.runWithWriteAuthority, stores.readWriteToken);
    this.store = this.trackCardStore(store);
    this.boardStore = this.track(stores.boards, { sessions: true });
    this.sessionsBoardStore = stores.sessionsBoard;
    this.subscriptionStore = {
      ...this.track(stores.subscriptions, { notifyChanges: false }),
      entries: (options) => this.runOperation(() => stores.subscriptions.entries(options)),
    };
    this.attachmentStore = {
      ...this.track(stores.attachments, { notifyChanges: false }),
      // Deletion also removes the card's metadata row, unlike blob-only registration.
      delete: (key) => this.trackMutation(() => stores.attachments.delete(key)),
    };
  }

  async list(options: WorkboardListOptions = {}): Promise<WorkboardCard[]> {
    const boardId = normalizeBoardId(options.boardId);
    return readCards(this.store, boardId === undefined ? undefined : { kind: "board", boardId });
  }

  listCards(
    board: unknown,
    sessionKey?: string,
    after?: WorkboardCardCursor,
  ): Promise<
    WorkboardListResult & {
      boards: WorkboardBoardSummary[];
      revision: WorkboardChange & { boardId?: string; sessionKey?: string };
    }
  > {
    return this.runOperation(() => {
      const boardId = normalizeBoardId(board);
      const writeToken = this.refreshWriteReceipt();
      const revision = this.cardsRevision;
      const cacheable = sessionKey === undefined && after === undefined;
      const cached = cacheable ? this.cardLists.get(boardId) : undefined;
      if (cached) {
        return cached;
      }
      const pending: ReturnType<WorkboardBoardStore["listCards"]> = Promise.all([
        this.store.entries({ kind: "page", boardId, sessionKey, after, limit: 101 }),
        this.listBoards(),
      ])
        .then(([entries, { boards }]) => {
          const cards = entries.slice(0, 100).map(({ value }) => value.card);
          const last = cards.at(-1);
          const result = {
            cards: cards.toSorted(compareCards).map(redactClaimToken),
            ...(entries.length > 100 && last
              ? { nextCursor: { position: last.position, createdAt: last.createdAt, id: last.id } }
              : {}),
            boards,
            statuses: WORKBOARD_STATUSES,
            revision: {
              ...revision,
              ...(boardId === undefined ? {} : { boardId }),
              ...(sessionKey === undefined ? {} : { sessionKey }),
            },
          };
          // A concurrent update may finish this read with older facts; the writer
          // receipt invalidates them on the next request.
          return result;
        })
        .catch((error: unknown) => {
          if (cacheable) {
            this.cardLists.delete(boardId);
          }
          throw error;
        });
      if (writeToken !== undefined && cacheable) {
        this.cardLists.set(boardId, pending);
      }
      return pending;
    });
  }

  listBoards(): Promise<{ boards: WorkboardBoardSummary[] }> {
    return this.runOperation(() => {
      const writeToken = this.refreshWriteReceipt();
      if (this.boardList) {
        return this.boardList;
      }
      const pending = this.readBoardSummaries().catch((error: unknown) => {
        if (this.boardList === pending) {
          this.boardList = undefined;
        }
        throw error;
      });
      if (writeToken !== undefined) {
        this.boardList = pending;
      }
      return pending;
    });
  }

  private async readBoardSummaries(): Promise<{ boards: WorkboardBoardSummary[] }> {
    const boards = new Map<string, WorkboardBoardSummary>();
    for (const entry of await this.boardStore.entries()) {
      const { createdAt: _createdAt, archivedAt, ...board } = entry.value.board;
      boards.set(board.id, {
        ...board,
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        ...(archivedAt ? { archivedAt } : {}),
      });
    }
    if (!boards.has("default")) {
      boards.set("default", emptyBoardSummary("default"));
    }
    const cardAggregates = await this.store.listBoardAggregates();
    for (const aggregate of cardAggregates) {
      const boardId = aggregate.boardId;
      const summary = boards.get(boardId) ?? emptyBoardSummary(boardId);
      summary.total += aggregate.total;
      summary.archived += aggregate.archived;
      summary.active += aggregate.total - aggregate.archived;
      summary.byStatus[aggregate.status] =
        (summary.byStatus[aggregate.status] ?? 0) + aggregate.total;
      summary.updatedAt = Math.max(summary.updatedAt ?? 0, aggregate.updatedAt);
      boards.set(boardId, summary);
    }
    return {
      boards: [...boards.values()].toSorted((a, b) =>
        a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id),
      ),
    };
  }

  async upsertBoard(input: WorkboardBoardInput): Promise<WorkboardBoardMetadata> {
    return await this.enqueueMutation(async () => {
      const id = normalizeBoardIdRequired(input.id);
      const existing = await this.boardStore.lookup(id);
      const board = normalizeBoardMetadata({ ...input, id }, existing?.board);
      await this.boardStore.register(id, { version: 1, board });
      return board.kind === "sessions" ? await this.getSessionsBoard(id) : board;
    });
  }

  getSessionsBoard(boardId: string): Promise<WorkboardSessionsBoard> {
    return this.runOperation(() => this.sessionsBoardStore.get(normalizeBoardIdRequired(boardId)));
  }

  updateSessionsBoard(
    boardId: string,
    patch: unknown,
    assertCurrent?: () => void,
  ): Promise<WorkboardSessionsBoard> {
    return this.enqueueMutation(
      () =>
        this.trackMutation(
          () => this.sessionsBoardStore.update(normalizeBoardIdRequired(boardId), patch),
          () => true,
          true,
        ),
      assertCurrent,
    );
  }

  listSessionPlacements(boardId: string): Promise<WorkboardSessionPlacement[]> {
    return this.runOperation(() =>
      this.sessionsBoardStore.listPlacements(normalizeBoardIdRequired(boardId)),
    );
  }

  repairSessionPlacements(): Promise<{ placements: number; boards: number }> {
    return this.enqueueMutation(() =>
      this.trackMutation(
        () => this.sessionsBoardStore.repairPlacements(),
        (result) => result.placements > 0 || result.boards > 0,
        true,
      ),
    );
  }

  writeSessionPlacement(
    boardId: string,
    placement: WorkboardSessionPlacementWrite,
    options: { expectedSpec: WorkboardSessionsBoardSpec; assertCurrent?: () => void },
  ): Promise<boolean> {
    return this.enqueueMutation(
      () =>
        this.trackMutation(
          () =>
            this.sessionsBoardStore.writePlacement(
              normalizeBoardIdRequired(boardId),
              placement,
              options.expectedSpec,
            ),
          Boolean,
          true,
        ),
      options.assertCurrent,
    );
  }

  async assertCardsBoard(boardId: string): Promise<void> {
    if (
      (await this.boardStore.lookup(normalizeBoardIdRequired(boardId)))?.board.kind === "sessions"
    ) {
      throw new Error("Sessions boards do not hold cards");
    }
  }

  async archiveBoard(id: unknown, archived: unknown = true): Promise<WorkboardBoardMetadata> {
    return await this.upsertBoard({ id, archived });
  }

  async deleteBoard(id: unknown): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => {
      const boardId = normalizeBoardIdRequired(id);
      if (boardId === "default") {
        throw new Error("default board cannot be deleted.");
      }
      if (await this.store.hasCards(boardId)) {
        throw new Error("board still has cards; archive it or move/delete the cards first.");
      }
      for (const entry of await this.subscriptionStore.entries({ boardId })) {
        await this.subscriptionStore.delete(entry.key);
      }
      return { deleted: await this.boardStore.delete(boardId) };
    });
  }
}
