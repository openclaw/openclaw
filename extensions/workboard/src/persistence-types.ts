// Workboard plugin module implements persistence types behavior.
import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardNotificationSubscription,
} from "@openclaw/workboard-contract";

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

export type WorkboardSubscriptionStore = Omit<
  WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>,
  "entries"
> & {
  entries(options?: {
    boardId?: string;
    cardId?: string;
  }): Promise<Array<{ key: string; value: PersistedWorkboardNotificationSubscription }>>;
};

type WorkboardBoardCardAggregate = {
  boardId: string;
  status: WorkboardCard["status"];
  total: number;
  archived: number;
  updatedAt: number;
};

export type WorkboardCardStatsAggregate = {
  status: WorkboardCard["status"];
  agentId: string | undefined;
  total: number;
  archived: number;
  updatedAt: number;
  oldestReadyAt: number | undefined;
};

export type WorkboardOwnerClaimResult = "updated" | "conflict" | "owner_busy";

export type WorkboardCardReadScope =
  | { kind: "board"; boardId: string }
  | { kind: "session"; sessionKey: string }
  | {
      kind: "worker-context";
      cardId: string;
      boardId: string;
      agentId?: string;
      parentIds: readonly string[];
    };

export type WorkboardCardStore = Omit<WorkboardKeyedStore, "entries"> & {
  entries(
    scope?: WorkboardCardReadScope,
  ): Promise<Array<{ key: string; value: PersistedWorkboardCard }>>;
  registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean>;
  registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean>;
  deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): Promise<boolean>;
  claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
  ): Promise<WorkboardOwnerClaimResult>;
  listCardStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: string }>>;
  listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]>;
  listStatsAggregates(boardId?: string): Promise<WorkboardCardStatsAggregate[]>;
  hasCards(boardId: string): Promise<boolean>;
};
