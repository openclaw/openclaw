import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSymbol } from "./options.js";

export type WatchlistRecord = {
  symbol: string;
  owner: {
    channel: "discord";
    senderId: string;
  };
  createdAt: string;
};

export type WatchlistStoreState = {
  watchlists: WatchlistRecord[];
};

export type WatchlistStore = {
  add(params: { senderId: string; symbol: string }): Promise<WatchlistRecord>;
  remove(params: { senderId: string; symbol: string }): Promise<WatchlistRecord | null>;
  list(params: { senderId: string }): Promise<WatchlistRecord[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWatchlistState(value: unknown): WatchlistStoreState {
  if (!isRecord(value) || !Array.isArray(value.watchlists)) {
    return { watchlists: [] };
  }
  return {
    watchlists: value.watchlists.flatMap((entry) => {
      if (!isRecord(entry) || !isRecord(entry.owner)) {
        return [];
      }
      const symbol = typeof entry.symbol === "string" ? normalizeSymbol(entry.symbol) : "";
      const senderId =
        typeof entry.owner.senderId === "string" && entry.owner.senderId.trim()
          ? entry.owner.senderId.trim()
          : undefined;
      const createdAt =
        typeof entry.createdAt === "string" && entry.createdAt.trim()
          ? entry.createdAt
          : new Date(0).toISOString();
      return symbol && senderId
        ? [{ symbol, owner: { channel: "discord" as const, senderId }, createdAt }]
        : [];
    }),
  };
}

async function readState(filePath: string): Promise<WatchlistStoreState> {
  try {
    return readWatchlistState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { watchlists: [] };
    }
    throw error;
  }
}

async function writeState(filePath: string, state: WatchlistStoreState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function parseWatchlistSymbol(input: string): string | null {
  const match = /^\$?([A-Za-z]{1,6})$/.exec(input.trim());
  if (!match) {
    return null;
  }
  const symbol = normalizeSymbol(match[1]);
  return symbol || null;
}

export function createWatchlistStore(stateDir: string): WatchlistStore {
  const filePath = path.join(stateDir, "gesahni", "watchlists.json");
  return {
    async add(params) {
      const symbol = normalizeSymbol(params.symbol);
      const state = await readState(filePath);
      const existing = state.watchlists.find(
        (entry) => entry.owner.senderId === params.senderId && entry.symbol === symbol,
      );
      if (existing) {
        return existing;
      }
      const record: WatchlistRecord = {
        symbol,
        owner: {
          channel: "discord",
          senderId: params.senderId,
        },
        createdAt: new Date().toISOString(),
      };
      state.watchlists.push(record);
      await writeState(filePath, state);
      return record;
    },
    async remove(params) {
      const symbol = normalizeSymbol(params.symbol);
      const state = await readState(filePath);
      const index = state.watchlists.findIndex(
        (entry) => entry.owner.senderId === params.senderId && entry.symbol === symbol,
      );
      if (index < 0) {
        return null;
      }
      const [removed] = state.watchlists.splice(index, 1);
      await writeState(filePath, state);
      return removed ?? null;
    },
    async list(params) {
      const state = await readState(filePath);
      return state.watchlists
        .filter((entry) => entry.owner.senderId === params.senderId)
        .toSorted((left, right) => left.symbol.localeCompare(right.symbol));
    },
  };
}

export function formatWatchlist(records: WatchlistRecord[]): string {
  if (records.length === 0) {
    return "No private watchlist symbols are saved.";
  }
  return `Private watchlist: ${records.map((entry) => entry.symbol).join(", ")}`;
}
