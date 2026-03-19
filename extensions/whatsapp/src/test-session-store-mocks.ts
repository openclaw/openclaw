import fs from "node:fs";

type SessionStore = Record<string, Record<string, unknown>>;

function readStore(storePath: string): SessionStore {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SessionStore) : {};
  } catch {
    return {};
  }
}

function writeStore(storePath: string, store: SessionStore): void {
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function loadSessionStoreForTests(storePath: string): SessionStore {
  return readStore(storePath);
}

export async function updateSessionStoreForTests(
  storePath: string,
  updater: (store: SessionStore) => void,
): Promise<void> {
  const store = readStore(storePath);
  updater(store);
  writeStore(storePath, store);
}

export async function updateLastRouteForTests(params: {
  storePath: string;
  sessionKey: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
}): Promise<void> {
  await updateSessionStoreForTests(params.storePath, (store) => {
    const current = store[params.sessionKey] ?? {};
    const deliveryContext = params.deliveryContext ?? {};
    store[params.sessionKey] = {
      ...current,
      updatedAt: Date.now(),
      lastChannel: deliveryContext.channel,
      lastTo: deliveryContext.to,
      lastAccountId: deliveryContext.accountId,
      lastThreadId: deliveryContext.threadId,
      deliveryContext: {
        ...(typeof deliveryContext.channel === "string"
          ? { channel: deliveryContext.channel }
          : {}),
        ...(typeof deliveryContext.to === "string" ? { to: deliveryContext.to } : {}),
        ...(typeof deliveryContext.accountId === "string"
          ? { accountId: deliveryContext.accountId }
          : {}),
        ...(typeof deliveryContext.threadId === "string"
          ? { threadId: deliveryContext.threadId }
          : {}),
      },
    };
  });
}

export async function recordSessionMetaFromInboundForTests(params: {
  storePath: string;
  sessionKey: string;
}): Promise<void> {
  await updateSessionStoreForTests(params.storePath, (store) => {
    const current = store[params.sessionKey] ?? {};
    store[params.sessionKey] = {
      ...current,
      updatedAt: Date.now(),
    };
  });
}
