import type { ActionRunner } from "../types.js";
import { agentPromptAction } from "./agent-prompt-action.js";
import { crawlRefreshAction } from "./crawl-refresh-action.js";
import type { ActionRunnerDeps, ScheduleActionType } from "./types.js";

/**
 * The schedulable action registry. Add a ScheduleActionType here to expose a new
 * recurring capability — schedule_create enumerates these, and the Scheduler
 * dispatches to the runner built from the matching entry. Nothing else changes.
 */
export const SCHEDULE_ACTIONS: readonly ScheduleActionType[] = [crawlRefreshAction, agentPromptAction];

/** Agent-facing action names, for the schedule_create enum. */
export function actionNames(): string[] {
  return SCHEDULE_ACTIONS.map((a) => a.name);
}

/** Resolve an action by its agent-facing name. */
export function actionByName(name: string): ScheduleActionType | undefined {
  return SCHEDULE_ACTIONS.find((a) => a.name === name);
}

/** Build the scheduler's runners map (dispatch key → runner) from the registry. */
export function buildRunners(deps: ActionRunnerDeps): Record<string, ActionRunner> {
  return Object.fromEntries(SCHEDULE_ACTIONS.map((a) => [a.tool, a.makeRunner(deps)]));
}
