import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { formatAlertInstrument, type AlertRecord, type AlertStore } from "./alerts.js";
import type { MarketDataClient, MarketQuote } from "./market-data.js";

export type AlertDelivery = (params: {
  cfg: OpenClawConfig;
  alert: AlertRecord;
  text: string;
}) => Promise<void>;

export type AlertRunResult = {
  checked: number;
  triggered: number;
  skipped: number;
  errors: number;
};

const DEFAULT_ALERT_RESULT: AlertRunResult = {
  checked: 0,
  triggered: 0,
  skipped: 0,
  errors: 0,
};

function readEasternMarketClock(now: Date): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    hour: Number.parseInt(value("hour"), 10),
    minute: Number.parseInt(value("minute"), 10),
  };
}

export function isRegularMarketHours(now: Date = new Date()): boolean {
  const clock = readEasternMarketClock(now);
  if (clock.weekday === "Sat" || clock.weekday === "Sun") {
    return false;
  }
  const minutes = clock.hour * 60 + clock.minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function quoteValue(quote: MarketQuote): number | undefined {
  return (
    quote.mark ??
    (quote.bid !== undefined && quote.ask !== undefined ? (quote.bid + quote.ask) / 2 : undefined)
  );
}

async function fetchAlertValue(params: {
  alert: AlertRecord;
  marketData: MarketDataClient;
}): Promise<number | undefined> {
  const quote =
    params.alert.instrument.kind === "equity"
      ? await params.marketData.quote(params.alert.instrument.symbol)
      : await params.marketData.optionQuote(params.alert.instrument);
  return quoteValue(quote);
}

function conditionMet(alert: AlertRecord, value: number): boolean {
  return alert.condition.operator === ">="
    ? value >= alert.condition.value
    : value <= alert.condition.value;
}

function isPastCooldown(alert: AlertRecord, now: Date): boolean {
  if (!alert.lastTriggeredAt) {
    return true;
  }
  const last = Date.parse(alert.lastTriggeredAt);
  if (!Number.isFinite(last)) {
    return true;
  }
  return now.getTime() - last >= alert.schedule.cooldownSeconds * 1000;
}

function shouldTrigger(alert: AlertRecord, met: boolean, now: Date): boolean {
  if (!met) {
    return false;
  }
  if (alert.lastConditionMet === true) {
    return false;
  }
  return isPastCooldown(alert, now);
}

function formatAlertTrigger(alert: AlertRecord, value: number): string {
  const op = alert.condition.operator === ">=" ? "above" : "below";
  const lines = [
    `Stock alert: ${formatAlertInstrument(alert.instrument)} is ${op} ${alert.condition.value.toFixed(2)}.`,
    `Current ${alert.condition.metric}: ${value.toFixed(2)}.`,
  ];
  if (alert.reference?.basis === "entry_price") {
    const diff = value - alert.reference.value;
    const pct = (diff / alert.reference.value) * 100;
    lines.push(
      `Entry reference: ${alert.reference.value.toFixed(2)} (${diff >= 0 ? "+" : ""}${diff.toFixed(2)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`,
    );
  }
  lines.push("Want me to dig into the setup or add another alert?");
  return lines.join("\n");
}

export async function deliverDiscordAlert(params: {
  cfg: OpenClawConfig;
  alert: AlertRecord;
  text: string;
}): Promise<void> {
  const to = params.alert.delivery.target;
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel: "discord",
    to,
    payloads: [{ text: params.text }],
    bestEffort: true,
    session: {
      conversationType: params.alert.scope === "private" ? "direct" : "group",
      ...(params.alert.owner.senderId ? { requesterSenderId: params.alert.owner.senderId } : {}),
    },
  });
}

export async function runAlertCheck(params: {
  cfg: OpenClawConfig;
  store: AlertStore;
  marketData: MarketDataClient;
  deliver?: AlertDelivery;
  now?: Date;
  marketHoursOpen?: boolean;
  onError?: (error: unknown, alert: AlertRecord) => void;
}): Promise<AlertRunResult> {
  const now = params.now ?? new Date();
  const checkedAt = now.toISOString();
  if (params.marketHoursOpen ?? isRegularMarketHours(now)) {
    // Continue below.
  } else {
    return { ...DEFAULT_ALERT_RESULT, skipped: (await params.store.listActive()).length };
  }

  const deliver = params.deliver ?? deliverDiscordAlert;
  const alerts = await params.store.listActive();
  const result = { ...DEFAULT_ALERT_RESULT };
  for (const alert of alerts) {
    result.checked += 1;
    try {
      const value = await fetchAlertValue({ alert, marketData: params.marketData });
      if (value === undefined) {
        await params.store.recordEvaluation(alert.id, {
          checkedAt,
          conditionMet: false,
        });
        continue;
      }
      const met = conditionMet(alert, value);
      const trigger = shouldTrigger(alert, met, now);
      if (trigger) {
        await deliver({
          cfg: params.cfg,
          alert,
          text: formatAlertTrigger(alert, value),
        });
        result.triggered += 1;
      }
      await params.store.recordEvaluation(alert.id, {
        checkedAt,
        observedValue: value,
        conditionMet: met,
        ...(trigger ? { triggeredAt: checkedAt } : {}),
      });
    } catch (error) {
      result.errors += 1;
      params.onError?.(error, alert);
    }
  }
  return result;
}
