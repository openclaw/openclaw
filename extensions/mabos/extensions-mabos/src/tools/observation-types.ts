/**
 * Observation Types — Data model for the Observer/Reflector compression pipeline.
 */

export type ObservationPriority = "critical" | "important" | "routine";

export interface Observation {
  id: string;
  priority: ObservationPriority;
  content: string;
  observed_at: string;
  referenced_dates?: string[];
  source_message_range?: [number, number];
  source_tool_calls?: string[];
  tags: string[];
  superseded_by?: string;
  created_at: string;
}

export interface ObservationLog {
  observations: Observation[];
  last_observer_run_at?: string;
  last_reflector_run_at?: string;
  total_messages_compressed: number;
  total_tool_calls_compressed: number;
  version: number;
}

export function priorityEmoji(p: ObservationPriority): string {
  switch (p) {
    case "critical":
      return "\u{1F534}";
    case "important":
      return "\u{1F7E1}";
    case "routine":
      return "\u{1F7E2}";
  }
}

export function importanceToPriority(n: number): ObservationPriority {
  if (n >= 0.8) return "critical";
  if (n >= 0.5) return "important";
  return "routine";
}

export function createEmptyLog(): ObservationLog {
  return {
    observations: [],
    total_messages_compressed: 0,
    total_tool_calls_compressed: 0,
    version: 1,
  };
}
