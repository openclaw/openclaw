import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type PluginHookAgentContext = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  trigger?: string;
};

type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type TemporalContextConfig = {
  enabled?: boolean;
  timeZone?: string;
  locale?: string;
  statePath?: string;
  maxStateEntries?: number;
  debug?: boolean;
};

type TemporalSessionState = {
  sessionKey: string;
  channel: string;
  lastUserTurnAt: string;
  lastUserTurnAtMs: number;
  previousUserTurnAt: string | null;
  turnCount: number;
};

type TemporalState = {
  schema: "openclaw.temporal-context.v1";
  updatedAt?: string;
  sessions?: Record<string, TemporalSessionState>;
};

type ResolvedTemporalContextConfig = Required<Omit<TemporalContextConfig, "statePath">> & {
  statePath: string;
};

const DEFAULT_TIME_ZONE = "UTC";
const DEFAULT_LOCALE = "en-US";
const DEFAULT_MAX_STATE_ENTRIES = 500;
const DEFAULT_STATE_FILE = "temporal-context-state.json";
const MIN_STATE_ENTRIES = 1;
const MAX_STATE_ENTRIES = 10_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedIntegerOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function openClawHome(): string {
  const configured = process.env.OPENCLAW_HOME?.trim();
  return configured
    ? resolve(configured.replace(/^~(?=$|[\\/])/, homedir()))
    : resolve(homedir(), ".openclaw");
}

function resolveConfigPath(input: string | undefined): string {
  const fallback = resolve(openClawHome(), "state", DEFAULT_STATE_FILE);
  if (!input?.trim()) {
    return fallback;
  }
  const expanded = input
    .trim()
    .replace(/^\$OPENCLAW_HOME(?=$|[\\/])/, openClawHome())
    .replace(/^~(?=$|[\\/])/, homedir());
  return resolve(expanded);
}

function resolveConfig(api: OpenClawPluginApi): ResolvedTemporalContextConfig {
  const raw = asRecord(api.pluginConfig) ?? {};
  return {
    enabled: booleanOr(raw.enabled, true),
    timeZone: stringOr(raw.timeZone, DEFAULT_TIME_ZONE),
    locale: stringOr(raw.locale, DEFAULT_LOCALE),
    statePath: resolveConfigPath(typeof raw.statePath === "string" ? raw.statePath : undefined),
    maxStateEntries: boundedIntegerOr(
      raw.maxStateEntries,
      DEFAULT_MAX_STATE_ENTRIES,
      MIN_STATE_ENTRIES,
      MAX_STATE_ENTRIES,
    ),
    debug: booleanOr(raw.debug, false),
  };
}

function readJson(path: string, fallback: TemporalState): TemporalState {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return asRecord(parsed) ? (parsed as TemporalState) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: TemporalState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function inferChannelFromSessionKey(sessionKey: string | undefined): string {
  const key = sessionKey || "";
  const match = /^agent:[^:]+:([^:]+)/.exec(key);
  return match?.[1] || "";
}

function sessionKeyFrom(
  _event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext,
): string {
  return ctx.sessionKey || ctx.sessionId || ctx.runId || "unknown-session";
}

function channelFrom(ctx: PluginHookAgentContext): string {
  return (
    ctx.messageProvider?.trim() ||
    ctx.trigger?.trim() ||
    inferChannelFromSessionKey(ctx.sessionKey) ||
    "unknown"
  );
}

function formatDateTimeParts(date: Date, timeZone: string, locale: string) {
  const longDate = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
  const isoLocalDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return { longDate, time, isoLocalDate };
}

export function describeElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  if (days < 45) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const months = Math.round(days / 30);
  if (months < 18) {
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}

function compactState(state: TemporalState, nowMs: number, maxStateEntries: number): TemporalState {
  const sessions = asRecord(state.sessions) ?? {};
  const sorted = Object.entries(sessions)
    .toSorted(
      ([, a], [, b]) =>
        Number(asRecord(b)?.lastUserTurnAtMs || 0) - Number(asRecord(a)?.lastUserTurnAtMs || 0),
    )
    .slice(0, maxStateEntries) as Array<[string, TemporalSessionState]>;
  return {
    schema: "openclaw.temporal-context.v1",
    updatedAt: new Date(nowMs).toISOString(),
    sessions: Object.fromEntries(sorted),
  };
}

function buildContextBlock(params: {
  now: Date;
  previous: TemporalSessionState | null;
  channel: string;
  timeZone: string;
  locale: string;
}): string {
  const parts = formatDateTimeParts(params.now, params.timeZone, params.locale);
  const lines = [
    "<temporal_context>",
    `Current local date: ${parts.longDate}`,
    `Current local time: ${parts.time}`,
    `Local ISO date: ${parts.isoLocalDate}`,
    `Timezone: ${params.timeZone}`,
    `Conversation surface: ${params.channel}`,
  ];

  if (params.previous?.lastUserTurnAtMs) {
    const elapsedMs = params.now.getTime() - params.previous.lastUserTurnAtMs;
    const previousDate = new Date(params.previous.lastUserTurnAtMs);
    const prevParts = formatDateTimeParts(previousDate, params.timeZone, params.locale);
    lines.push(`Time since previous user turn in this session: ${describeElapsed(elapsedMs)}`);
    lines.push(`Previous user turn local time: ${prevParts.longDate} at ${prevParts.time}`);
  } else {
    lines.push("Time since previous user turn in this session: no previous turn recorded");
  }

  lines.push(
    "Use this for temporal grounding, recency, scheduling language, and stale-context checks. Do not mention it unless it helps the user.",
  );
  lines.push("</temporal_context>");
  return lines.join("\n");
}

export default definePluginEntry({
  id: "temporal-context",
  name: "Temporal Context",
  description: "Injects current local time and elapsed-time context into agent turns.",
  register(api: OpenClawPluginApi) {
    api.on(
      "before_prompt_build",
      async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => {
        const cfg = resolveConfig(api);
        if (!cfg.enabled) {
          return undefined;
        }
        try {
          const now = new Date();
          const nowMs = now.getTime();
          const sessionKey = sessionKeyFrom(event, ctx);
          const channel = channelFrom(ctx);
          const state = readJson(cfg.statePath, {
            schema: "openclaw.temporal-context.v1",
            sessions: {},
          });
          const previous = state.sessions?.[sessionKey] ?? null;
          const prependSystemContext = buildContextBlock({
            now,
            previous,
            channel,
            timeZone: cfg.timeZone,
            locale: cfg.locale,
          });

          const nextSessions: Record<string, TemporalSessionState> = {
            ...state.sessions,
            [sessionKey]: {
              sessionKey,
              channel,
              lastUserTurnAt: now.toISOString(),
              lastUserTurnAtMs: nowMs,
              previousUserTurnAt: previous?.lastUserTurnAt || null,
              turnCount: (previous?.turnCount || 0) + 1,
            },
          };
          writeJsonAtomic(
            cfg.statePath,
            compactState(
              { schema: "openclaw.temporal-context.v1", sessions: nextSessions },
              nowMs,
              cfg.maxStateEntries,
            ),
          );

          if (cfg.debug) {
            api.logger.info(`temporal-context: injected for ${sessionKey} (${channel})`);
          }
          return { prependSystemContext };
        } catch (error) {
          api.logger.warn(
            `temporal-context: injection failed: ${String((error as Error)?.stack || error)}`,
          );
          return undefined;
        }
      },
      { priority: 20, timeoutMs: 750 },
    );

    api.registerService({
      id: "temporal-context",
      start: () => api.logger.info("temporal-context: ready"),
      stop: () => {},
    });
  },
});
