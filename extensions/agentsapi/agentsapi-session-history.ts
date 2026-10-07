import { setTimeout as delay } from "node:timers/promises";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import {
  isAgentsApiTerminalTurn,
  type AgentsApiClient,
  type AgentsApiItem,
} from "./agentsapi-client.js";

export function createAgentsApiSessionHistory(options: {
  sessionId: string;
  cleanupClient: AgentsApiClient;
  getBaselineTurnId: () => string | undefined;
  coordinatorTurnIds: ReadonlySet<string>;
  priorInputItemIds: ReadonlySet<string>;
  readAdmittedTurns: (client: AgentsApiClient, signal: AbortSignal) => Promise<Turn[]>;
  rememberItemTurn: (itemId: string, turnId: string) => void;
  observeInputItems: (items: Set<string>) => void;
  callbacks: {
    onReconcile?: (turn: Turn, items: AgentsApiItem[]) => Promise<void | boolean>;
    onReconcileHistory?: (entries: Array<{ turn: Turn; items: AgentsApiItem[] }>) => Promise<void>;
    onUsageError?: (error: unknown) => void;
  };
}) {
  const {
    sessionId,
    cleanupClient,
    coordinatorTurnIds,
    priorInputItemIds,
    readAdmittedTurns,
    rememberItemTurn,
  } = options;
  const readItemsByTurn = async (readClient: AgentsApiClient, readSignal: AbortSignal) => {
    const savedItems = await readClient.items(sessionId, undefined, readSignal);
    readSignal.throwIfAborted();
    const itemsByTurn = new Map<string, AgentsApiItem[]>();
    for (const item of savedItems) {
      if (!item.turn_id) {
        continue;
      }
      const items = itemsByTurn.get(item.turn_id) ?? [];
      items.push(item);
      itemsByTurn.set(item.turn_id, items);
    }
    return itemsByTurn;
  };
  const readSavedState = async (readClient: AgentsApiClient, readSignal: AbortSignal) => {
    const turns = await readAdmittedTurns(readClient, readSignal);
    const entries: Array<{ turn: Turn; items: AgentsApiItem[] }> = [];
    const inputItems = new Set<string>();
    const itemsByTurn =
      turns.length || options.getBaselineTurnId()
        ? await readItemsByTurn(readClient, readSignal)
        : new Map<string, AgentsApiItem[]>();
    for (const turn of turns) {
      const items = itemsByTurn.get(turn.id) ?? [];
      for (const item of items) {
        rememberItemTurn(item.id, turn.id);
        if (item.type === "message" && item.role === "user" && !priorInputItemIds.has(item.id)) {
          inputItems.add(item.id);
        }
      }
      entries.push({ turn, items });
    }
    options.observeInputItems(inputItems);
    return { turns, entries, itemsByTurn };
  };
  const projectSavedState = async (
    entries: Array<{ turn: Turn; items: AgentsApiItem[] }>,
    readSignal: AbortSignal,
  ) => {
    let transcriptReady = true;
    for (const { turn, items } of entries) {
      readSignal.throwIfAborted();
      const ready = await options.callbacks.onReconcile?.(turn, items);
      transcriptReady = ready !== false && transcriptReady;
      readSignal.throwIfAborted();
    }
    return transcriptReady;
  };
  const reconcilePriorHistory = async (
    readClient: AgentsApiClient,
    readSignal: AbortSignal,
    itemsByTurn: Map<string, AgentsApiItem[]>,
  ) => {
    if (!options.getBaselineTurnId() || !options.callbacks.onReconcileHistory) {
      return;
    }
    const turns = await readClient.turns(sessionId, readSignal);
    readSignal.throwIfAborted();
    const baselineIndex = turns.findIndex((turn) => turn.id === options.getBaselineTurnId());
    if (baselineIndex < 0) {
      throw new Error("Agents API historical reconciliation lost its baseline turn");
    }
    const priorTurns = turns
      .slice(0, baselineIndex + 1)
      .filter((turn) => isAgentsApiTerminalTurn(turn.status));
    if (!priorTurns.length) {
      return;
    }
    // Historical facts repair the retained conversation without entering this
    // attempt's admission, live presentation, tool lifecycle, or token accounting.
    await options.callbacks.onReconcileHistory(
      priorTurns.map((turn) => ({
        turn,
        items: itemsByTurn.get(turn.id) ?? [],
      })),
    );
    readSignal.throwIfAborted();
  };
  const readUsageTurns = async () => {
    const usageSignal = AbortSignal.timeout(5_000);
    let turns: Turn[] = [];
    // Idle can precede the REST records and their usage. Give accounting
    // a bounded settlement window, without treating unknown usage as zero.
    try {
      while (true) {
        turns = await cleanupClient.turns(sessionId, usageSignal, options.getBaselineTurnId());
        const recordedIds = new Set(turns.map((turn) => turn.id));
        if (
          turns.length > 0 &&
          [...coordinatorTurnIds].every((id) => recordedIds.has(id)) &&
          turns.every((turn) => turn.usage !== null)
        ) {
          return turns;
        }
        await delay(500, undefined, { signal: usageSignal });
      }
    } catch (error) {
      if (!usageSignal.aborted) {
        options.callbacks.onUsageError?.(error);
      }
      return turns;
    }
  };

  return {
    readItemsByTurn,
    readSavedState,
    projectSavedState,
    reconcilePriorHistory,
    readUsageTurns,
  };
}
