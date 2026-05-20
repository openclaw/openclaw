import fs from "node:fs/promises";
import path from "node:path";
import type { GesahniConfig } from "./config.js";
import { normalizeSymbol, parseEntryPrice, parseOptionContract } from "./options.js";

export type AlertScope = "group" | "private";
export type AlertStatus = "pending" | "active" | "fired" | "deleted";
export type AlertInstrument =
  | {
      kind: "equity";
      symbol: string;
    }
  | {
      kind: "option_contract";
      symbol: string;
      expiry: string;
      strike: number;
      right: "call" | "put";
      occSymbol: string;
    };

export type AlertRecord = {
  id: string;
  scope: AlertScope;
  owner: {
    channel: string;
    senderId?: string;
  };
  instrument: AlertInstrument;
  condition: {
    metric: "price" | "mark";
    operator: ">=" | "<=";
    value: number;
  };
  reference?: {
    basis: "entry_price";
    value: number;
    contracts?: number;
  };
  delivery: {
    channel: "discord";
    target: string;
    label: string;
  };
  schedule: {
    marketHours: "regular";
    pollSeconds: number;
    cooldownSeconds: number;
    dedupe: "state_change";
    expiresAt?: string;
  };
  status: AlertStatus;
  originalText: string;
  createdAt: string;
  confirmedAt?: string;
  lastCheckedAt?: string;
  lastObservedValue?: number;
  lastConditionMet?: boolean;
  lastTriggeredAt?: string;
  triggerCount?: number;
};

export type AlertStoreState = {
  alerts: AlertRecord[];
};

export type AlertStore = {
  preview(alert: AlertRecord): Promise<AlertRecord>;
  confirm(id: string, senderId?: string): Promise<AlertRecord | null>;
  confirmLatest(params: { scope?: AlertScope; senderId?: string }): Promise<AlertRecord | null>;
  delete(id: string, senderId?: string): Promise<AlertRecord | null>;
  deleteLatestPending(params: {
    scope?: AlertScope;
    senderId?: string;
  }): Promise<AlertRecord | null>;
  deleteMatching(params: {
    scope?: AlertScope;
    senderId?: string;
    symbol?: string;
    conditionValue?: number;
  }): Promise<AlertRecord | null>;
  list(params: { scope?: AlertScope; senderId?: string }): Promise<AlertRecord[]>;
  listActive(): Promise<AlertRecord[]>;
  recordEvaluation(
    id: string,
    evaluation: {
      checkedAt: string;
      observedValue?: number;
      conditionMet: boolean;
      triggeredAt?: string;
    },
  ): Promise<AlertRecord | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAlertState(value: unknown): AlertStoreState {
  if (!isRecord(value) || !Array.isArray(value.alerts)) {
    return { alerts: [] };
  }
  return {
    alerts: value.alerts.filter(isRecord) as AlertRecord[],
  };
}

async function readState(filePath: string): Promise<AlertStoreState> {
  try {
    return readAlertState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { alerts: [] };
    }
    throw error;
  }
}

async function writeState(filePath: string, state: AlertStoreState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function defaultExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(alert: AlertRecord, nowMs = Date.now()): boolean {
  if (!alert.schedule.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(alert.schedule.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function canAccessAlert(alert: AlertRecord, senderId?: string): boolean {
  return !alert.owner.senderId || !senderId || alert.owner.senderId === senderId;
}

function matchesListParams(alert: AlertRecord, params: { scope?: AlertScope; senderId?: string }) {
  if (isExpired(alert)) {
    return false;
  }
  if (params.scope && alert.scope !== params.scope) {
    return false;
  }
  if (alert.scope === "private") {
    return Boolean(params.senderId && alert.owner.senderId === params.senderId);
  }
  return true;
}

function latestByCreatedAt(alerts: AlertRecord[]): AlertRecord | undefined {
  return alerts.toSorted(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )[0];
}

function alertMatchesSymbol(alert: AlertRecord, symbol?: string): boolean {
  return !symbol || alert.instrument.symbol === symbol;
}

function alertMatchesConditionValue(alert: AlertRecord, conditionValue?: number): boolean {
  return conditionValue === undefined || Math.abs(alert.condition.value - conditionValue) < 0.005;
}

export function createAlertStore(stateDir: string): AlertStore {
  const filePath = path.join(stateDir, "gesahni", "alerts.json");
  return {
    async preview(alert) {
      const state = await readState(filePath);
      const next = {
        ...alert,
        status: "pending" as const,
      };
      state.alerts = state.alerts.filter((entry) => entry.id !== next.id).concat(next);
      await writeState(filePath, state);
      return next;
    },
    async confirm(id, senderId) {
      const state = await readState(filePath);
      const alert = state.alerts.find((entry) => entry.id === id && entry.status === "pending");
      if (!alert) {
        return null;
      }
      if (!canAccessAlert(alert, senderId) || isExpired(alert)) {
        return null;
      }
      alert.status = "active";
      alert.confirmedAt = new Date().toISOString();
      await writeState(filePath, state);
      return alert;
    },
    async confirmLatest(params) {
      const state = await readState(filePath);
      const alert = latestByCreatedAt(
        state.alerts.filter(
          (entry) =>
            entry.status === "pending" &&
            matchesListParams(entry, params) &&
            canAccessAlert(entry, params.senderId),
        ),
      );
      if (!alert) {
        return null;
      }
      alert.status = "active";
      alert.confirmedAt = new Date().toISOString();
      await writeState(filePath, state);
      return alert;
    },
    async delete(id, senderId) {
      const state = await readState(filePath);
      const alert = state.alerts.find(
        (entry) =>
          entry.id === id &&
          (entry.status === "active" || entry.status === "pending") &&
          canAccessAlert(entry, senderId),
      );
      if (!alert) {
        return null;
      }
      alert.status = "deleted";
      await writeState(filePath, state);
      return alert;
    },
    async deleteLatestPending(params) {
      const state = await readState(filePath);
      const alert = latestByCreatedAt(
        state.alerts.filter(
          (entry) =>
            entry.status === "pending" &&
            matchesListParams(entry, params) &&
            canAccessAlert(entry, params.senderId),
        ),
      );
      if (!alert) {
        return null;
      }
      alert.status = "deleted";
      await writeState(filePath, state);
      return alert;
    },
    async deleteMatching(params) {
      const state = await readState(filePath);
      const alert = latestByCreatedAt(
        state.alerts.filter(
          (entry) =>
            entry.status === "active" &&
            matchesListParams(entry, params) &&
            canAccessAlert(entry, params.senderId) &&
            alertMatchesSymbol(entry, params.symbol) &&
            alertMatchesConditionValue(entry, params.conditionValue),
        ),
      );
      if (!alert) {
        return null;
      }
      alert.status = "deleted";
      await writeState(filePath, state);
      return alert;
    },
    async list(params) {
      const state = await readState(filePath);
      return state.alerts.filter(
        (entry) => entry.status === "active" && matchesListParams(entry, params),
      );
    },
    async listActive() {
      const state = await readState(filePath);
      return state.alerts.filter((entry) => entry.status === "active" && !isExpired(entry));
    },
    async recordEvaluation(id, evaluation) {
      const state = await readState(filePath);
      const alert = state.alerts.find((entry) => entry.id === id && entry.status === "active");
      if (!alert) {
        return null;
      }
      alert.lastCheckedAt = evaluation.checkedAt;
      alert.lastConditionMet = evaluation.conditionMet;
      if (evaluation.observedValue !== undefined) {
        alert.lastObservedValue = evaluation.observedValue;
      }
      if (evaluation.triggeredAt) {
        alert.lastTriggeredAt = evaluation.triggeredAt;
        alert.triggerCount = (alert.triggerCount ?? 0) + 1;
      }
      await writeState(filePath, state);
      return alert;
    },
  };
}

function makeAlertId(): string {
  return `alrt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseThreshold(input: string): { operator: ">=" | "<="; value: number } | null {
  const match =
    /\b(?:above|over|breaks?|hits?|>=|at least)\s+\$?(\d+(?:\.\d+)?)/i.exec(input) ??
    /\b(?:below|under|<=|at most)\s+\$?(\d+(?:\.\d+)?)/i.exec(input);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const prefix = match[0].toLowerCase();
  return {
    operator: /\b(below|under|<=|at most)\b/.test(prefix) ? "<=" : ">=",
    value,
  };
}

function parseScope(input: string, defaultScope: AlertScope = "group"): AlertScope {
  if (/\b(me|private|personal|dm)\b/i.test(input)) {
    return "private";
  }
  return defaultScope;
}

function parseEquitySymbol(input: string): string | null {
  const ignored = new Set([
    "alert",
    "group",
    "private",
    "personal",
    "when",
    "gets",
    "over",
    "under",
    "above",
    "below",
    "breaks",
    "hits",
    "watch",
    "pr",
    "me",
    "if",
    "it",
  ]);
  for (const token of input.match(/\$?[A-Za-z]{1,6}\b/g) ?? []) {
    const symbol = normalizeSymbol(token);
    if (!ignored.has(symbol.toLowerCase())) {
      return symbol;
    }
  }
  return null;
}

export function parseAlertRequest(params: {
  input: string;
  config: GesahniConfig;
  channel: string;
  senderId?: string;
  currentDiscordChannelId?: string;
  defaultScope?: AlertScope;
}): AlertRecord | null {
  const input = params.input.trim();
  const threshold = parseThreshold(input);
  if (!threshold) {
    return null;
  }
  const scope = parseScope(input, params.defaultScope);
  const option = parseOptionContract(input);
  const equitySymbol = option ? option.symbol : parseEquitySymbol(input);
  if (!equitySymbol) {
    return null;
  }
  const instrument: AlertInstrument = option
    ? {
        kind: "option_contract",
        symbol: option.symbol,
        expiry: option.expiry,
        strike: option.strike,
        right: option.right,
        occSymbol: option.occSymbol,
      }
    : { kind: "equity", symbol: equitySymbol };
  const groupChannelId = params.config.alerts?.groupChannelId;
  const groupChannelName = params.config.alerts?.groupChannelName ?? "stock-alerts";
  const privateTarget = params.senderId ? `user:${params.senderId}` : "user:unknown";
  const delivery =
    scope === "private"
      ? { channel: "discord" as const, target: privateTarget, label: "DM" }
      : {
          channel: "discord" as const,
          target: groupChannelId ? `channel:${groupChannelId}` : "channel:stock-alerts",
          label: `#${groupChannelName}`,
        };
  const entryPrice = parseEntryPrice(input);
  const createdAt = new Date().toISOString();
  return {
    id: makeAlertId(),
    scope,
    owner: {
      channel: params.channel,
      senderId: params.senderId,
    },
    instrument,
    condition: {
      metric: instrument.kind === "option_contract" ? "mark" : "price",
      ...threshold,
    },
    ...(entryPrice ? { reference: { basis: "entry_price", value: entryPrice } } : {}),
    delivery,
    schedule: {
      marketHours: "regular",
      pollSeconds: params.config.alerts?.pollSeconds ?? 30,
      cooldownSeconds: params.config.alerts?.cooldownSeconds ?? 300,
      dedupe: "state_change",
      expiresAt: defaultExpiresAt(createdAt),
    },
    status: "pending",
    originalText: input,
    createdAt,
  };
}

export function formatAlertInstrument(instrument: AlertInstrument): string {
  if (instrument.kind === "equity") {
    return instrument.symbol;
  }
  return `${instrument.symbol} ${instrument.strike}${instrument.right === "call" ? "C" : "P"} ${instrument.expiry}`;
}

export function formatAlertPreview(alert: AlertRecord): string {
  const op = alert.condition.operator === ">=" ? "above" : "below";
  if (alert.scope === "private") {
    return [
      "Private alert preview:",
      `- Symbol: ${formatAlertInstrument(alert.instrument)}`,
      `- Condition: ${alert.condition.metric} ${op} ${alert.condition.value.toFixed(2)}`,
      "- Scope: private DM",
      "- Delivery: this DM",
      "- Expiration: 7 days",
      'Reply "confirm" to save or "cancel" to discard.',
      "I can also remember your timezone/watchlist/alert style later.",
    ].join("\n");
  }
  return [
    `Group alert preview: ${formatAlertInstrument(alert.instrument)} ${op} ${alert.condition.value.toFixed(2)}.`,
    `Delivery: ${alert.delivery.label}.`,
    "Hours: regular market hours.",
    `Check cadence: every ${alert.schedule.pollSeconds} seconds.`,
    `Cooldown: ${Math.round(alert.schedule.cooldownSeconds / 60)} minutes after trigger.`,
    `Alert id: ${alert.id}`,
    `Reply with /alert confirm ${alert.id} to save.`,
  ].join("\n");
}

export function formatAlertSaved(alert: AlertRecord): string {
  const op = alert.condition.operator === ">=" ? "above" : "below";
  if (alert.scope === "private") {
    return `Saved private alert for ${formatAlertInstrument(alert.instrument)} ${op} ${alert.condition.value.toFixed(
      2,
    )}.`;
  }
  return `Alert saved: ${formatAlertInstrument(alert.instrument)} ${op} ${alert.condition.value.toFixed(
    2,
  )} -> ${alert.delivery.label}.`;
}

export function formatAlertList(alerts: AlertRecord[], scope: AlertScope): string {
  if (alerts.length === 0) {
    return scope === "private" ? "No private alerts are active." : "No group alerts are active.";
  }
  return alerts
    .map((alert) => {
      const op = alert.condition.operator === ">=" ? "above" : "below";
      return `- ${alert.id}: ${formatAlertInstrument(alert.instrument)} ${op} ${alert.condition.value.toFixed(2)} -> ${alert.delivery.label}`;
    })
    .join("\n");
}
