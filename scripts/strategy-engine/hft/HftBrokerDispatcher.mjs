import { runCapitalLiveTradingPromotionGate } from "../../openclaw-capital-live-trading-promotion-gate.mjs";
/**
 * HftBrokerDispatcher.mjs - HFT signal -> BrokerAdapter dispatcher.
 * The dispatcher is intentionally injectable into HftEngine so the engine does
 * not own broker writes, credentials, or promotion decisions.
 */
import { CapitalAdapter } from "../brokers/CapitalAdapter.mjs";
import { OkxAdapter } from "../brokers/OkxAdapter.mjs";

const BUY_DIRECTIONS = new Set(["buy", "close_short"]);
const SELL_DIRECTIONS = new Set(["sell", "close_long"]);

function normalizeBroker(signal = {}) {
  const explicit = String(signal.broker ?? "")
    .trim()
    .toLowerCase();
  if (explicit) {
    return explicit;
  }
  const symbol = String(signal.symbol ?? signal.instrument ?? "");
  return symbol.includes("/") || symbol.includes("USDT") ? "okx" : "capital";
}

function normalizeSide(direction) {
  const value = String(direction ?? "")
    .trim()
    .toLowerCase();
  if (BUY_DIRECTIONS.has(value)) {
    return "buy";
  }
  if (SELL_DIRECTIONS.has(value)) {
    return "sell";
  }
  return value;
}

export function hftSignalToOrder(signal = {}) {
  const symbol = String(signal.symbol ?? signal.instrument ?? "").trim();
  const side = normalizeSide(signal.side ?? signal.direction);
  const qty = Number(signal.qty ?? signal.quantity ?? 1);
  return {
    symbol,
    side,
    qty,
    type: signal.type ?? "market",
    price: signal.price,
    strategy: signal.strategy ?? signal.name ?? "hft",
    dryRun: signal.dryRun !== false,
    source: "hft",
    rawDirection: signal.direction ?? signal.side ?? "",
  };
}

export class HftBrokerDispatcher {
  constructor(options = {}) {
    this.adapters = options.adapters ?? {
      capital: new CapitalAdapter({ mode: options.capitalMode ?? "paper" }),
      okx: new OkxAdapter({ mode: options.okxMode ?? "paper" }),
    };
    this.runPromotionGate = options.runPromotionGate ?? runCapitalLiveTradingPromotionGate;
    this.allowLiveExecution = options.allowLiveExecution === true;
    this.events = [];
  }

  async dispatchSignal(signal) {
    const broker = normalizeBroker(signal);
    const adapter = this.adapters[broker];
    const order = hftSignalToOrder(signal);
    const eventBase = {
      broker,
      order,
      strategy: order.strategy,
      createdAt: new Date().toISOString(),
    };

    if (!adapter) {
      return this.record({
        ...eventBase,
        ok: false,
        status: "rejected",
        sentOrder: false,
        message: `Unknown broker: ${broker}`,
      });
    }

    if (adapter.isLive) {
      const { report } = await this.runPromotionGate({ writeState: true });
      return this.record({
        ...eventBase,
        ok: false,
        status: "blocked_live_promotion",
        sentOrder: false,
        promotionGate: {
          status: report.status,
          readyForManualReview: report.readyForManualReview,
          blockerCode: report.blockerCode,
          blockers: report.blockers,
        },
        message: this.allowLiveExecution
          ? "Live adapter is still blocked by promotion gate."
          : "Live execution flag is off; promotion gate kept broker write disabled.",
      });
    }

    const result = await adapter.submitOrder(order);
    return this.record({
      ...eventBase,
      ok: result.status !== "rejected",
      status: result.status ?? "unknown",
      orderResult: result,
      sentOrder: false,
      message: result.message ?? "",
    });
  }

  record(event) {
    this.events.push(event);
    return event;
  }
}
