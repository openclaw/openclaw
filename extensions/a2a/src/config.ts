/**
 * A2A plugin configuration types and parser.
 *
 * Config path: plugins.entries.a2a.config
 */

// ── Types ──────────────────────────────────────────────────────────

export type A2APeerAuth = {
  type: "bearer";
  token: string;
};

export type A2APeer = {
  name: string;
  agentCardUrl: string;
  auth?: A2APeerAuth;
};

export type A2ACardSkill = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
};

export type A2APluginConfig = {
  enabled: boolean;

  card: {
    name: string;
    description: string;
    version: string;
    skills: A2ACardSkill[];
    defaultInputModes: string[];
    defaultOutputModes: string[];
  };

  auth: {
    mode: "none" | "bearer";
    token?: string;
  };

  routing: {
    defaultAgentId: string;
  };

  peers: A2APeer[];

  timeouts: {
    agentResponseMs: number;
    taskRetentionMs: number;
  };
};

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  cardName: "OpenClaw Agent",
  cardDescription: "OpenClaw A2A-enabled agent",
  cardVersion: "1.0.0",
  defaultInputModes: ["text"] as string[],
  defaultOutputModes: ["text"] as string[],
  authMode: "bearer" as const,
  defaultAgentId: "default",
  agentResponseMs: 300_000,
  taskRetentionMs: 86_400_000, // 24h
} as const;

// ── Parser ─────────────────────────────────────────────────────────

function str(val: unknown, fallback: string): string {
  return typeof val === "string" && val.trim() ? val.trim() : fallback;
}

function num(val: unknown, fallback: number): number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : fallback;
}

function parsePeers(raw: unknown): A2APeer[] {
  if (!Array.isArray(raw)) return [];
  const peers: A2APeer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const agentCardUrl = typeof e.agentCardUrl === "string" ? e.agentCardUrl.trim() : "";
    if (!name || !agentCardUrl) continue;

    let auth: A2APeerAuth | undefined;
    if (e.auth && typeof e.auth === "object") {
      const a = e.auth as Record<string, unknown>;
      if (a.type === "bearer" && typeof a.token === "string" && a.token.trim()) {
        auth = { type: "bearer", token: a.token.trim() };
      }
    }
    peers.push({ name, agentCardUrl, auth });
  }
  return peers;
}

function parseSkills(raw: unknown): A2ACardSkill[] {
  if (!Array.isArray(raw)) {
    return [{ id: "chat", name: "Chat", description: "General-purpose chat" }];
  }
  const skills: A2ACardSkill[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const name = typeof e.name === "string" ? e.name.trim() : id;
    const description = typeof e.description === "string" ? e.description.trim() : "";
    if (!id) continue;
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === "string")
      : undefined;
    skills.push({ id, name, description, ...(tags ? { tags } : {}) });
  }
  return skills.length > 0
    ? skills
    : [{ id: "chat", name: "Chat", description: "General-purpose chat" }];
}

export function parseA2AConfig(raw: unknown): A2APluginConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const card = (cfg.card ?? {}) as Record<string, unknown>;
  const auth = (cfg.auth ?? {}) as Record<string, unknown>;
  const routing = (cfg.routing ?? {}) as Record<string, unknown>;
  const timeouts = (cfg.timeouts ?? {}) as Record<string, unknown>;

  const authMode = auth.mode === "none" ? "none" : DEFAULTS.authMode;
  const authToken = typeof auth.token === "string" ? auth.token.trim() : undefined;

  // Warn if bearer mode has no token
  if (authMode === "bearer" && !authToken) {
    // Will be logged by the plugin entry — config parser stays pure
  }

  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,

    card: {
      name: str(card.name, DEFAULTS.cardName),
      description: str(card.description, DEFAULTS.cardDescription),
      version: str(card.version, DEFAULTS.cardVersion),
      skills: parseSkills(card.skills),
      defaultInputModes: Array.isArray(card.defaultInputModes)
        ? card.defaultInputModes.filter((m): m is string => typeof m === "string")
        : DEFAULTS.defaultInputModes,
      defaultOutputModes: Array.isArray(card.defaultOutputModes)
        ? card.defaultOutputModes.filter((m): m is string => typeof m === "string")
        : DEFAULTS.defaultOutputModes,
    },

    auth: { mode: authMode, token: authToken },

    routing: {
      defaultAgentId: str(routing.defaultAgentId, DEFAULTS.defaultAgentId),
    },

    peers: parsePeers(cfg.peers),

    timeouts: {
      agentResponseMs: num(timeouts.agentResponseMs, DEFAULTS.agentResponseMs),
      taskRetentionMs: num(timeouts.taskRetentionMs, DEFAULTS.taskRetentionMs),
    },
  };
}

// ── Config schema for plugin definition ────────────────────────────

export const a2aConfigSchema = {
  parse(value: unknown): A2APluginConfig {
    return parseA2AConfig(value);
  },
  uiHints: {
    enabled: { label: "Enable A2A Gateway" },
    "card.name": { label: "Agent Card Name" },
    "card.description": { label: "Agent Description" },
    "auth.mode": { label: "Inbound Auth Mode" },
    "auth.token": { label: "Inbound Bearer Token", sensitive: true },
    "routing.defaultAgentId": { label: "Default Agent ID" },
    peers: { label: "Remote Peers", advanced: true },
    "timeouts.agentResponseMs": { label: "Agent Response Timeout (ms)", advanced: true },
    "timeouts.taskRetentionMs": { label: "Task Retention (ms)", advanced: true },
  },
};
