// ── Shared Types ──────────────────────────────────────────────

export interface SPData {
  visit_count: number;
  visit_streak: number;
  last_visit: string;
  first_visit: string;
  total_time_sec: number;
  interactions: { cup: number; journal: number; cruz: number };
  personality_signals: {
    action: number;
    analysis: number;
    empathy: number;
    inspiration: number;
    influence: number;
    explorer: number;
  };
}

export interface NarrativeScript {
  name: string;
  text: string;
}

export interface CoffeeResult {
  total: number;
  today: number;
  forceClose?: boolean;
  farewell?: string;
}

export interface VisitResult {
  streak: number;
  recognized: boolean;
  forceClose?: boolean;
  farewell?: string;
}

export interface CafeState {
  coffees: Record<string, number>;
  visitors_today: number;
  notes: unknown[];
  forceClose: boolean;
  absentDays: number;
}

export interface BriefingData {
  beat: number;
  date: string;
  time: string;
  gateway: boolean;
  cpu_load: number;
  threads_unreplied: number;
  actions?: string[];
}

export interface AmbientState {
  doing: string;
  where: string;
  with: string;
  updated_at: string;
  mood: 'busy' | 'rest' | 'deep_work' | 'teaching' | 'present';
  generated_at: string;
}
