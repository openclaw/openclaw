/**
 * Goal Precondition Evaluation — Checks whether goals can be activated.
 *
 * Precondition types:
 * - goal_state: Another goal must be in a specific state
 * - condition: Named boolean condition (e.g., "budget_approved")
 * - expression: Composite expression (future use)
 *
 * When all preconditions for a pending goal are satisfied,
 * the goal becomes eligible for activation (pending → active).
 */

import { validateTransition } from "./goal-state-machine.js";
import { getTypeDBClient } from "./typedb-client.js";
import { GoalStoreQueries } from "./typedb-queries.js";

/**
 * Evaluate a goal_state precondition by checking if the referenced goal
 * is in the required state.
 */
export async function evaluateGoalStatePrecondition(
  dbName: string,
  referencedGoalId: string,
  requiredState: string,
): Promise<boolean> {
  const client = getTypeDBClient();
  if (!client.isAvailable()) return false;

  try {
    const res = await client.matchQuery(
      `match $g isa goal, has uid ${JSON.stringify(referencedGoalId)}, has goal_state ${JSON.stringify(requiredState)};`,
      dbName,
    );
    if (!res || res.answerType !== "conceptRows") return false;
    return res.answers.length > 0;
  } catch {
    return false;
  }
}

/**
 * Find all pending goals for an agent where all preconditions are satisfied,
 * and transition them from pending → active.
 *
 * Returns the IDs of goals that were activated.
 */
export async function activatePendingGoals(dbName: string, agentId: string): Promise<string[]> {
  const client = getTypeDBClient();
  if (!client.isAvailable()) return [];

  const activated: string[] = [];

  try {
    const res = await client.matchQuery(GoalStoreQueries.findActivatableGoals(agentId), dbName);
    if (!res || res.answerType !== "conceptRows") return [];

    for (const row of res.answers) {
      const gid = "value" in (row.data["gid"] ?? {}) ? (row.data["gid"] as any).value : null;
      if (!gid) continue;

      try {
        validateTransition("pending", "active");
        const transitionId = `GST-${gid}-${Date.now()}`;
        await client.insertData(
          GoalStoreQueries.transitionGoalState(agentId, gid, "active", transitionId),
          dbName,
        );
        activated.push(gid);
      } catch {
        // Invalid transition or insert failure — skip
      }
    }
  } catch {
    // Query failure — return what we have
  }

  return activated;
}
