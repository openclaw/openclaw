// Raw DashboardState from window.__STATE__ (sentinel Python output)
// Copied from garden/src/state/types.ts

export interface DashboardState {
  updated_at: string;
  started_at: string;

  jarvis: {
    overall: number;
    layers: Record<
      "perceive" | "think" | "act" | "autonomy",
      { score: number; items: Record<string, boolean> }
    >;
    meta: {
      gateway: boolean;
      bridge: boolean;
      sentinel: boolean;
      db_today: number;
      agents: number;
      bindings: number;
      skills: number;
      exp_count: number;
      reports: number;
      report_latest: string;
    };
    roadmap: Array<{ priority: string; desc: string; done: boolean }>;
    checked_at: string;
  };

  thought_stream: Array<{ t: string; ph: string; msg: string }>;

  observation: {
    at: string;
    svc: Record<string, boolean>;
    disk: number;
    swap: number;
    cpu: Array<{ proc: string; pct: number }>;
    issues: string[];
  };

  services: Record<
    string,
    {
      running: boolean;
      healthy: boolean;
      port_open: boolean;
      pid: number | null;
      error: string | null;
    }
  >;

  system: {
    disk: { used_pct: number; free_gb: number };
    swap_mb: number;
    cpu_top: Array<{ proc: string; pct: number }>;
  };

  deltas: Array<{
    kind: string;
    name: string;
    label: string;
    issue: string;
    desired: string;
    actual: string;
    risk: string;
    action: string;
    first_seen: string;
    notified_at: string;
    next_notify: string;
    owner: string;
  }>;

  reconcile: {
    action_log: Array<{
      at: string;
      delta: string;
      action: string;
      auto: boolean;
      success: boolean;
    }>;
    backoffs: Record<
      string,
      { retries: number; delay: number; next_attempt: string }
    >;
    config_checksums: Record<string, string>;
  };

  tasks: {
    last_task: { name: string; at: string; ok: boolean };
    task_runs: Record<string, number>;
    last_task_dates: Record<string, string>;
  };

  conversation_pulse: {
    known_alerts: Record<
      string,
      { first_seen: string; last_notified: string; count: number }
    >;
    last_run: string;
    last_result: {
      groups_scanned: number;
      messages_analyzed: number;
      alerts_sent: number;
      issue_count: number;
      issues: Array<{
        chat_name: string;
        type: string;
        severity: string;
        detail: string;
      }>;
    };
  };

  conversation_sync: {
    last_synced: Record<string, number>;
    last_run: string;
    last_result: {
      groups_synced: number;
      new_messages: number;
      errors: string[];
      db_size_mb: number;
      group_stats: Record<
        string,
        {
          name: string;
          count: number;
          earliest: string;
          latest: string;
          fresh_h: number;
          agent_id?: string;
          recent_messages?: Array<{ sender: string; text: string; ts: string }>;
        }
      >;
    };
  };

  agent_health: {
    known_alerts: Record<
      string,
      { first_seen: string; last_notified: string; count: number }
    >;
    last_run: string;
    last_result: {
      agents_checked: number;
      structure_fixes: number;
      rule_injections: number;
      p1_count: number;
      p1_issues: string[];
      agents: Record<
        string,
        {
          score: number;
          max: number;
          fixes: string[];
          rules: Record<string, boolean>;
        }
      >;
    };
  };

  observations_24h: Array<{
    at: string;
    svc: Record<string, boolean>;
    disk: number;
    swap: number;
    cpu: Array<{ proc: string; pct: number }>;
    issues: string[];
    delta_count: number;
  }>;

  topology: {
    gateway: { port: number };
    bridges: Record<string, { port: number; agents: string[] }>;
    tunnel: Record<string, { target: string }>;
  };

  agent_chat_map: Record<
    string,
    { primary_chat: string; bridge_port: number; label: string }
  >;

  line_stats?: {
    ok: boolean;
    total: number;
    recent_24h: number;
    group_count: number;
    groups: Record<
      string,
      {
        name: string;
        count: number;
        earliest: string;
        latest: string;
        fresh_h: number;
      }
    >;
    queried_at: string;
  };

  data_mirror?: {
    db_exists: boolean;
    sync: { last_synced_date: string; last_run: string };
    archive: { last_run: string | null; last_result: unknown };
    size_gb: number;
    tables: Record<
      string,
      { rows: number; earliest: string; latest: string }
    >;
    total_rows: number;
  };

  private_chats?: {
    known: Array<{
      userId: string;
      name: string;
      bridge: string;
      priority: string;
      agentId?: string;
      agentColor?: string;
      status: "known";
    }>;
    unknown: Array<{
      userId: string;
      name: string;
      bridge: string;
      priority: string;
      agentId?: string;
      agentColor?: string;
      status: "unknown";
    }>;
  };

  agent_roster?: Array<ProjectDef & {
    model?: string;
    permissions?: Record<string, { deny: string[]; full: boolean }>;
    bridge?: string;
    bridgePort?: number;
  }>;

  matomo_health?: {
    known_alerts: Record<string, { first_seen: string; last_notified: string; count: number }>;
    last_run: string;
    last_result: {
      status: "ok" | "warn" | "critical" | "unreachable";
      checked_at: string;
      disk: { total: string; used: string; avail: string; used_pct: number; status: string };
      tables: {
        log_total_gb: number;
        hsr_total_gb: number;
        log_status: string;
        hsr_status: string;
        hsr_missing: string[];
        hsr_schema_ok: boolean;
        top5: Record<string, { mb: number; rows: number }>;
      };
      archive: { last_archive: string; age_hours: number; status: string };
      tracking: { visits_today: number; visits_yesterday: number; drop_pct: number; status: string };
      cleanup: { hsr_cron_exists: boolean; log_deletion_enabled: boolean };
      issues: string[];
      issue_count: number;
    };
  };

  api_errors?: {
    ok: boolean;
    total_24h: number;
    by_type: Record<string, number>;
    by_agent: Record<string, number>;
    hourly: Record<string, number>;
    recent: Array<{
      ts: string;
      type: string;
      agent: string;
      lane: string;
      duration_ms: number;
      error: string;
    }>;
    queried_at: string;
  };

  bioCorpus?: {
    updated_at: string;
    hormone: BioChakraMetric & {
      season: string;
      focus: string;
      ttl: string | null;
      suppress_count: number;
      amplify_count: number;
    };
    nerve: BioChakraMetric & {
      recent_pulses_5m: number;
      active_sources: number;
      source_list: string[];
    };
    threads: BioChakraMetric & {
      coverage_pct: number;
      total_comments: number;
      replied: number;
      unreplied: number;
    };
    shadow_clone: BioChakraMetric & {
      avg_score_24h: number;
      excellence_pct: number;
      total_replies_24h: number;
      trend: string;
    };
    memory: BioChakraMetric & {
      count: number;
    };
    maturity: {
      level: string;
      m1_root_flow: number;
      m2_forge_bond: number;
      m3_voice_mirror_void: number;
      overall: number;
    };
  };
}

// === BioCorpus types ===

export interface BioChakraMetric {
  chakra: string;
  label: string;
  score: number;
  status: string;
}

// === Empire-specific types ===

export type ProjectCategory = "work" | "family" | "tools";
export type GardenEntityType = "tree" | "flower" | "mushroom";

export interface ProjectDef {
  id: string;
  name: string;
  agentId: string;
  category: ProjectCategory;
  gardenType: GardenEntityType;
  color: string;
  emoji: string;
  chatIds: string[];
}

export interface GroupInfo {
  chatId: string;
  name: string;
  messageCount: number;
  freshHours: number;
  agentId?: string;
}

// Garden layer model
export interface PrivateChatNode {
  userId: string;
  name: string;
  bridge: string;
  priority: string;
  agentId?: string;
  color: string;
  status: "known" | "unknown";
}

export interface MatomoStatus {
  status: "ok" | "warn" | "critical" | "unreachable" | "unknown";
  diskPct: number;
  visitsToday: number;
  archiveAgeH: number;
  issueCount: number;
  issues: string[];
  checkedAt: string;
}

export interface EmpireGardenModel {
  updatedAt: string;
  jarvisScore: number;
  weather: "clear" | "cloudy" | "rainy" | "stormy";
  serviceHealthPct: number;
  projects: ProjectGardenNode[];
  privateChats: PrivateChatNode[];
  fireflies: EmpireFirefly[];
  totalMessages: number;
  totalAlerts: number;
  matomo: MatomoStatus;
}

export interface ProjectGardenNode {
  project: ProjectDef;
  totalMessages: number;
  avgFreshHours: number;
  activeGroups: number;
  agentScore: number;
  agentMaxScore: number;
  alerts: number;
  model?: string;
}

export interface EmpireFirefly {
  kind: "thought" | "alert" | "task" | "sync" | "error";
  msg: string;
  t: string;
}

// Office layer model
export interface OfficeModel {
  projectId: string;
  projectName: string;
  projectColor: string;
  agentId: string;
  agentName: string;
  agentScore: number;
  agentMaxScore: number;
  model?: string;
  rooms: RoomModel[];
  breakRoomAgents: string[];
}

export interface RecentMessage {
  sender: string;
  text: string;
  ts: string;
}

export interface RoomModel {
  chatId: string;
  name: string;
  messageCount: number;
  freshHours: number;
  agentState: "working" | "idle" | "away";
  recentMessages?: RecentMessage[];
  permissions?: { deny: string[]; full: boolean };
}
