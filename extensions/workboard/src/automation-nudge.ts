import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isCronSessionKey } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginService } from "../api.js";
import { cardBoardId } from "./store-card-helpers.js";
import { MAX_CARDS } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS = 60_000;

type WorkboardAutomationNudgeInput = {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
};

type WorkboardAutomationNudgeService = OpenClawPluginService & {
  stop: () => void;
  nudge: (input: WorkboardAutomationNudgeInput) => Promise<void>;
};

type PendingBoardNudge = {
  timer?: ReturnType<typeof setTimeout>;
};

type NudgeOwner = Pick<Parameters<OpenClawPluginService["start"]>[0], "logger" | "getCron">;

type WorkboardAutomationNudgeState = {
  owner?: NudgeOwner;
  pendingByBoard: Map<string, PendingBoardNudge>;
};

const WORKBOARD_AUTOMATION_NUDGE_STATE_KEY = Symbol.for("openclaw.workboard.automationNudgeState");

// Prepared model generations register fresh hook closures without starting their services.
// Shared state lets those closures reach the active service owner and its debounce fence.
function clearPendingBoardNudges(state: WorkboardAutomationNudgeState): void {
  for (const pending of state.pendingByBoard.values()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }
  state.pendingByBoard.clear();
}

function getWorkboardAutomationNudgeState(): WorkboardAutomationNudgeState {
  return resolveGlobalSingleton<WorkboardAutomationNudgeState>(
    WORKBOARD_AUTOMATION_NUDGE_STATE_KEY,
    () => ({ pendingByBoard: new Map<string, PendingBoardNudge>() }),
    (state) => {
      state.owner = undefined;
      clearPendingBoardNudges(state);
    },
  );
}

function isCronOriginSession(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim();
  // Cron keys are raw `cron:*` before store canonicalization and agent-scoped
  // `agent:*:cron:*:run:*` afterward; accepting either here would self-trigger.
  return normalized?.startsWith("cron:") === true || isCronSessionKey(normalized);
}

export function createWorkboardAutomationNudgeService(params: {
  store: WorkboardStore;
}): WorkboardAutomationNudgeService {
  let serviceOwner: NudgeOwner | undefined;

  const nudgeBoard = async (boardId: string, jobId: string, owner: NudgeOwner) => {
    const state = getWorkboardAutomationNudgeState();
    if (state.owner !== owner || state.pendingByBoard.has(boardId)) {
      return;
    }
    if (state.pendingByBoard.size >= MAX_CARDS) {
      owner.logger.warn(
        `workboard automation nudge skipped for board ${boardId}: debounce map full`,
      );
      return;
    }
    const pending: PendingBoardNudge = {};
    const expiresAt = Date.now() + WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS;
    // The board entry owns both the in-flight request and its cooldown, so a
    // second lifecycle event can never overlap the first automation run request.
    state.pendingByBoard.set(boardId, pending);
    try {
      const enqueueRun = owner.getCron?.()?.enqueueRun;
      if (!enqueueRun) {
        throw new Error("Workboard automation scheduler is unavailable");
      }
      const result = await enqueueRun(jobId, "if-enabled");
      if (!result.ok || ("ran" in result && !result.ran)) {
        const reason = "reason" in result ? result.reason : "not-run";
        owner.logger.warn(
          `workboard automation nudge skipped for board ${boardId}: job ${jobId} ${reason}`,
        );
        return;
      }
      const runId = "runId" in result ? result.runId : undefined;
      owner.logger.info(
        `workboard automation nudge requested for board ${boardId}: job ${jobId}${runId ? ` run ${runId}` : ""}`,
      );
    } catch (error) {
      // The automation schedule is the backstop; a nudge failure must not alter
      // lifecycle synchronization or card state.
      if (state.owner === owner) {
        owner.logger.warn(
          `workboard automation nudge failed for board ${boardId}: ${String(error)}`,
        );
      }
    } finally {
      if (state.owner === owner && state.pendingByBoard.get(boardId) === pending) {
        pending.timer = setTimeout(
          () => {
            if (state.pendingByBoard.get(boardId) === pending) {
              state.pendingByBoard.delete(boardId);
            }
          },
          Math.max(0, expiresAt - Date.now()),
        );
        pending.timer.unref?.();
      }
    }
  };

  return {
    id: "workboard-automation-nudge",
    start(ctx) {
      const state = getWorkboardAutomationNudgeState();
      clearPendingBoardNudges(state);
      state.owner = serviceOwner = { logger: ctx.logger, getCron: ctx.getCron };
    },
    stop() {
      const state = getWorkboardAutomationNudgeState();
      if (state.owner !== serviceOwner) {
        return;
      }
      state.owner = serviceOwner = undefined;
      clearPendingBoardNudges(state);
    },
    async nudge(input) {
      const state = getWorkboardAutomationNudgeState();
      const owner = state.owner;
      if (!owner || isCronOriginSession(input.sessionKey) || input.cards.length === 0) {
        return;
      }
      try {
        const automationByBoard = new Map(
          (await params.store.listBoards()).boards.flatMap((board) =>
            board.automationJobId ? [[board.id, board.automationJobId] as const] : [],
          ),
        );
        const boardIds = new Set(input.cards.map((card) => cardBoardId(card)));
        await Promise.all(
          [...boardIds].flatMap((boardId) => {
            const jobId = automationByBoard.get(boardId);
            return jobId ? [nudgeBoard(boardId, jobId, owner)] : [];
          }),
        );
      } catch (error) {
        if (state.owner === owner) {
          owner.logger.warn(`workboard automation nudge failed: ${String(error)}`);
        }
      }
    },
  };
}
