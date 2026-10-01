import { setTimeout as delay } from "node:timers/promises";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import {
  isAgentsApiTerminalTurn,
  type AgentsApiClient,
  type AgentsApiItem,
} from "./agentsapi-client.js";

/** Saved history supplies canonical facts; the session retains admission and recovery authority. */
export function createAgentsApiSessionHistory(options: {
  sessionId: string;
  getBaselineTurnId: () => string | undefined;
  readAdmittedTurns: (client: AgentsApiClient, signal: AbortSignal) => Promise<Turn[]>;
  readItemsByTurn: (
    client: AgentsApiClient,
    signal: AbortSignal,
    recoverCompletion: boolean,
  ) => Promise<Map<string, AgentsApiItem[]>>;
  rememberItemTurn: (itemId: string, turnId: string) => void;
  onInputItems: (items: Set<string>) => void;
  onReconcile?: (turn: Turn, items: AgentsApiItem[]) => Promise<void | boolean>;
  onReconcileHistory?: (entries: Array<{ turn: Turn; items: AgentsApiItem[] }>) => Promise<void>;
  onUsageError?: (error: unknown) => void;
}) {
  const { sessionId } = options;
  const readSavedState = async (
    readClient: AgentsApiClient,
    readSignal: AbortSignal,
    recoverCompletion = false,
  ) => {
    const turns = await options.readAdmittedTurns(readClient, readSignal);
    const entries: Array<{ turn: Turn; items: AgentsApiItem[] }> = [];
    const inputItems = new Set<string>();
    const itemsByTurn =
      turns.length || options.getBaselineTurnId()
        ? await options.readItemsByTurn(readClient, readSignal, recoverCompletion)
        : new Map<string, AgentsApiItem[]>();
    for (const turn of turns) {
      const items = itemsByTurn.get(turn.id) ?? [];
      for (const item of items) {
        options.rememberItemTurn(item.id, turn.id);
        if (item.type === "message" && item.role === "user") {
          inputItems.add(item.id);
        }
      }
      entries.push({ turn, items });
    }
    options.onInputItems(inputItems);
    return { turns, entries, itemsByTurn };
  };
  const projectSavedState = async (
    entries: Array<{ turn: Turn; items: AgentsApiItem[] }>,
    readSignal: AbortSignal,
  ) => {
    let transcriptReady = true;
    for (const { turn, items } of entries) {
      readSignal.throwIfAborted();
      const ready = await options.onReconcile?.(turn, items);
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
    const baselineTurnId = options.getBaselineTurnId();
    if (!baselineTurnId || !options.onReconcileHistory) {
      return;
    }
    const turns = await readClient.turns(sessionId, readSignal);
    readSignal.throwIfAborted();
    const baselineIndex = turns.findIndex((turn) => turn.id === baselineTurnId);
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
    await options.onReconcileHistory(
      priorTurns.map((turn) => ({
        turn,
        items: itemsByTurn.get(turn.id) ?? [],
      })),
    );
    readSignal.throwIfAborted();
  };
  const readUsageTurns = async (
    readClient: AgentsApiClient,
    requiredTurnIds: ReadonlySet<string>,
  ) => {
    const usageSignal = AbortSignal.timeout(5_000);
    let turns: Turn[] = [];
    // Idle can precede the REST records and their usage. Give accounting
    // a bounded settlement window, without treating unknown usage as zero.
    try {
      while (true) {
        turns = await readClient.turns(sessionId, usageSignal, options.getBaselineTurnId());
        const recordedIds = new Set(turns.map((turn) => turn.id));
        if (
          turns.length > 0 &&
          [...requiredTurnIds].every((id) => recordedIds.has(id)) &&
          turns.every((turn) => turn.usage !== null)
        ) {
          return turns;
        }
        await delay(500, undefined, { signal: usageSignal });
      }
    } catch (error) {
      if (!usageSignal.aborted) {
        options.onUsageError?.(error);
      }
      return turns;
    }
  };
  return { readSavedState, projectSavedState, reconcilePriorHistory, readUsageTurns };
}
