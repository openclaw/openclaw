// Matrix SDK helper mitigates fake-indexeddb finished-transaction retention.
const MATRIX_CRYPTO_DATABASE_SUFFIXES = [
  "::matrix-sdk-crypto",
  "::matrix-sdk-crypto-meta",
] as const;
const PRUNER_INSTALLED = Symbol.for("openclaw.matrix.fakeIndexedDbTransactionPruner");

type FakeIndexedDbTransaction = {
  _state?: string;
  addEventListener?: (type: "complete" | "abort", listener: () => void) => void;
  db?: FakeIndexedDbDatabaseConnection;
};

type FakeIndexedDbRawDatabase = {
  name?: string;
  transactions?: FakeIndexedDbTransaction[];
};

type FakeIndexedDbDatabaseConnection = {
  _rawDatabase?: FakeIndexedDbRawDatabase;
};

type FakeIndexedDbDatabasePrototype = FakeIndexedDbDatabaseConnection & {
  transaction?: IDBDatabase["transaction"];
  [PRUNER_INSTALLED]?: true;
};

type GlobalWithFakeIndexedDb = typeof globalThis & {
  IDBDatabase?: {
    prototype?: FakeIndexedDbDatabasePrototype;
  };
};

function getRawDatabase(value: unknown): FakeIndexedDbRawDatabase | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const rawDatabase = (value as FakeIndexedDbDatabaseConnection)["_rawDatabase"];
  if (!rawDatabase || typeof rawDatabase !== "object") {
    return undefined;
  }
  return rawDatabase;
}

function isMatrixCryptoDatabase(
  rawDatabase: FakeIndexedDbRawDatabase | undefined,
): rawDatabase is FakeIndexedDbRawDatabase & {
  transactions: FakeIndexedDbTransaction[];
} {
  if (!rawDatabase || !Array.isArray(rawDatabase.transactions)) {
    return false;
  }
  const databaseName = rawDatabase.name;
  return (
    typeof databaseName === "string" &&
    MATRIX_CRYPTO_DATABASE_SUFFIXES.some((suffix) => databaseName.endsWith(suffix))
  );
}

export function pruneFinishedFakeIndexedDbTransactions(rawDatabase: unknown): number {
  const matrixRawDatabase = rawDatabase as FakeIndexedDbRawDatabase | undefined;
  if (!isMatrixCryptoDatabase(matrixRawDatabase)) {
    return 0;
  }

  const transactions = matrixRawDatabase.transactions;
  const activeTransactions = transactions.filter(
    (transaction) => transaction?.["_state"] !== "finished",
  );
  const removed = transactions.length - activeTransactions.length;
  if (removed > 0) {
    transactions.splice(0, transactions.length, ...activeTransactions);
  }
  return removed;
}

export function installFakeIndexedDbTransactionPruner(): void {
  const globalObject = globalThis as GlobalWithFakeIndexedDb;
  const databasePrototype = globalObject.IDBDatabase?.prototype;
  const originalTransaction = databasePrototype?.transaction;
  if (
    !databasePrototype ||
    typeof originalTransaction !== "function" ||
    databasePrototype[PRUNER_INSTALLED]
  ) {
    return;
  }

  Object.defineProperty(databasePrototype, PRUNER_INSTALLED, {
    configurable: false,
    enumerable: false,
    value: true,
  });

  const patchedTransaction = function patchedMatrixFakeIndexedDbTransaction(
    this: IDBDatabase & FakeIndexedDbDatabaseConnection,
    ...args: Parameters<IDBDatabase["transaction"]>
  ): ReturnType<IDBDatabase["transaction"]> {
    pruneFinishedFakeIndexedDbTransactions(getRawDatabase(this));

    const transaction = originalTransaction.apply(this, args) as IDBTransaction &
      FakeIndexedDbTransaction;
    const rawDatabase = getRawDatabase(transaction?.db) ?? getRawDatabase(this);
    if (
      isMatrixCryptoDatabase(rawDatabase) &&
      typeof transaction?.addEventListener === "function"
    ) {
      const prune = (): void => {
        pruneFinishedFakeIndexedDbTransactions(rawDatabase);
      };
      transaction.addEventListener("complete", prune);
      transaction.addEventListener("abort", prune);
    }

    return transaction;
  } as IDBDatabase["transaction"];

  databasePrototype.transaction = patchedTransaction;
}
