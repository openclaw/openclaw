/**
 * Goal Type Semantics — Maps Tropos + BDI goal types to their formal properties.
 *
 * Tropos types: hardgoal, softgoal, task, resource
 * BDI types:    achieve, maintain, cease, avoid, query
 */

export type TemporalPattern = "once" | "continuous" | "negative";

export interface GoalTypeSemantics {
  description: string;
  temporalPattern: TemporalPattern;
  monitoringRequired: boolean;
}

export const GOAL_TYPE_SEMANTICS: Record<string, GoalTypeSemantics> = {
  // Tropos types
  hardgoal: {
    description: "Functional goal with clear success criteria",
    temporalPattern: "once",
    monitoringRequired: false,
  },
  softgoal: {
    description: "Non-functional quality goal (satisficed)",
    temporalPattern: "continuous",
    monitoringRequired: true,
  },
  task: {
    description: "Concrete executable action",
    temporalPattern: "once",
    monitoringRequired: false,
  },
  resource: {
    description: "Physical or informational resource needed",
    temporalPattern: "once",
    monitoringRequired: false,
  },
  // BDI types
  achieve: {
    description: "Reach a target state once",
    temporalPattern: "once",
    monitoringRequired: false,
  },
  maintain: {
    description: "Keep a state continuously true",
    temporalPattern: "continuous",
    monitoringRequired: true,
  },
  cease: {
    description: "Stop a currently true state",
    temporalPattern: "once",
    monitoringRequired: false,
  },
  avoid: {
    description: "Prevent a state from becoming true",
    temporalPattern: "continuous",
    monitoringRequired: true,
  },
  query: {
    description: "Find/derive information",
    temporalPattern: "once",
    monitoringRequired: false,
  },
};

/**
 * Returns semantics for a given goal type, falling back to hardgoal defaults.
 */
export function getGoalTypeSemantics(goalType: string): GoalTypeSemantics {
  return (
    GOAL_TYPE_SEMANTICS[goalType] ?? {
      description: "Unknown goal type",
      temporalPattern: "once" as const,
      monitoringRequired: false,
    }
  );
}
