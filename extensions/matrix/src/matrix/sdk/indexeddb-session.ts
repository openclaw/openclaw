import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

type SessionState = "active" | "retiring" | "retired" | "failed";

type Session = {
  state: SessionState;
  connections: Set<IDBDatabase>;
  pendingOpens: Set<Promise<void>>;
  transactions: Set<Promise<void>>;
  failure?: { error: unknown };
};

export type MatrixSdkIndexedDbSession = {
  retire: () => Promise<void>;
};

const registry = resolveGlobalSingleton<{
  sessions: Map<string, Session>;
  factory?: IDBFactory;
}>(Symbol.for("openclaw.matrix.sdkIndexedDbSessions"), () => ({ sessions: new Map() }));
const sessions = registry.sessions;

function retiredError(): DOMException {
  return new DOMException("Matrix crypto IndexedDB generation has retired", "InvalidStateError");
}

function trackTransaction(session: Session, transaction: IDBTransaction): void {
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  session.transactions.add(pending);
  const complete = () => {
    session.transactions.delete(pending);
    settle();
  };
  transaction.addEventListener("complete", complete, { once: true });
  transaction.addEventListener("abort", complete, { once: true });
}

function admitConnection(session: Session, database: IDBDatabase): void {
  if (session.connections.has(database)) {
    return;
  }
  session.connections.add(database);
  const transaction = database.transaction.bind(database);
  // Wrap only this SDK connection. Snapshot restore/export use independently
  // opened connections through the original factory and remain available.
  database.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
    if (session.state !== "active") {
      throw retiredError();
    }
    const result = transaction(...args);
    trackTransaction(session, result);
    return result;
  };
}

function openForSession(
  factory: IDBFactory,
  session: Session,
  name: string,
  version?: number,
): IDBOpenDBRequest {
  if (session.state !== "active") {
    throw retiredError();
  }
  const request = factory.open(name, version);
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  session.pendingOpens.add(pending);
  const complete = () => {
    session.pendingOpens.delete(pending);
    settle();
  };
  request.addEventListener("upgradeneeded", () => {
    admitConnection(session, request.result);
    if (session.state !== "active") {
      // A blocked open can start its upgrade after retirement. Prevent that
      // upgrade from publishing state, then join the resulting error event.
      request.transaction?.abort();
    } else if (request.transaction) {
      trackTransaction(session, request.transaction);
    }
  });
  request.addEventListener(
    "success",
    () => {
      try {
        admitConnection(session, request.result);
        if (session.state !== "active") {
          request.result.close();
        }
      } catch (error) {
        session.failure = { error };
        session.state = "failed";
      } finally {
        complete();
      }
    },
    { once: true },
  );
  request.addEventListener("error", complete, { once: true });
  return request;
}

function installSdkFactory(): void {
  if (registry.factory) {
    return;
  }
  const factory = globalThis.indexedDB;
  registry.factory = new Proxy(factory, {
    get(target, key) {
      if (key === "open") {
        return (name: string, version?: number) => {
          const session = sessions.get(name);
          return session
            ? openForSession(target, session, name, version)
            : target.open(name, version);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  globalThis.indexedDB = registry.factory;
}

/** Own SDK connections through stop; the physical store lock owns publication. */
export function beginMatrixSdkIndexedDbSession(
  databasePrefix = "matrix-js-sdk",
): MatrixSdkIndexedDbSession {
  installSdkFactory();
  // The public SDK's default prefix is matrix-js-sdk. Rust store operations use
  // their admitted Database connection; they do not reopen it after close.
  const names = [
    `${databasePrefix}::matrix-sdk-crypto`,
    `${databasePrefix}::matrix-sdk-crypto-meta`,
  ];
  if (
    names.some((name) => {
      const previous = sessions.get(name);
      return previous && previous.state !== "retired";
    })
  ) {
    throw new Error("Matrix SDK IndexedDB generation is still active or failed retirement");
  }
  const session: Session = {
    state: "active",
    connections: new Set(),
    pendingOpens: new Set(),
    transactions: new Set(),
  };
  for (const name of names) {
    sessions.set(name, session);
  }
  let retirement: Promise<void> | undefined;
  return {
    retire: () => {
      retirement ??= (async () => {
        session.state = "retiring";
        try {
          for (const connection of session.connections) {
            connection.close();
          }
          await Promise.all(session.pendingOpens);
          for (const connection of session.connections) {
            connection.close();
          }
          await Promise.all(session.transactions);
          if (session.failure) {
            throw session.failure.error;
          }
          session.state = "retired";
          // Native futures can retain connections, so their wrappers keep this
          // retired session. The registry remains closed until a successor begins.
          session.connections.clear();
        } catch (error) {
          session.state = "failed";
          throw error;
        }
      })();
      return retirement;
    },
  };
}
