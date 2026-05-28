import { writeFile, appendFile } from "node:fs/promises";

const COMMAND_FILE = "D:\\群益及元大API\\CapitalHftService\\hft_command.json";
const SIGNAL_LOG = "D:\\群益及元大API\\CapitalHftService\\state\\hft_strategy_signals.jsonl";

export class OrderRouter {
  constructor(dryRun = false) {
    this.dryRun = dryRun;
    this._sentCount = 0;
  }

  async routeSignal(signal) {
    const logEntry = JSON.stringify({
      ...signal,
      routedAt: new Date().toISOString(),
      dryRun: this.dryRun,
    });
    await this._appendLog(logEntry);

    if (this.dryRun) {
      console.log(
        `[DRY RUN] Signal: ${signal.strategy} ${signal.direction} ${signal.instrument} qty=${signal.qty} reason="${signal.reason}"`,
      );
      return { ok: true, dryRun: true };
    }

    if (signal.broker === "capital") {
      return this._routeToCapital(signal);
    } else if (signal.broker === "okx") {
      return this._routeToOkx(signal);
    }
    return { ok: false, error: "Unknown broker: " + signal.broker };
  }

  async _routeToCapital(signal) {
    const dayTradeMode = this._normalizeHoldingMode(signal);
    const cmd = {
      command: this._signalToCapitalCommand(signal),
      stockNo: signal.instrument,
      qty: signal.qty,
      dayTradeMode,
      dayTrade: dayTradeMode === "day_trade",
      sDayTrade: dayTradeMode === "day_trade" ? 1 : 0,
      holdingMode: dayTradeMode,
      sentAt: new Date().toISOString(),
      sentBy: "strategy-engine:" + signal.strategy,
    };
    await writeFile(COMMAND_FILE, JSON.stringify(cmd, null, 2), "utf-8");
    this._sentCount++;
    console.log(`[Capital] → ${cmd.command} ${signal.instrument} qty=${signal.qty}`);
    return { ok: true };
  }

  _normalizeHoldingMode(signal) {
    const raw = String(signal?.dayTradeMode ?? signal?.holdingMode ?? "day_trade")
      .trim()
      .toLowerCase()
      .replace(/[-\s]/gu, "_");
    if (["overnight", "non_day_trade", "nondaytrade"].includes(raw)) {
      return "overnight";
    }
    return "day_trade";
  }

  _signalToCapitalCommand(signal) {
    switch (signal.direction) {
      case "buy":
        return "send_future_order_buy_open";
      case "sell":
        return "send_future_order_sell_open";
      case "close_long":
        return "send_future_order_sell_close";
      case "close_short":
        return "send_future_order_buy_close";
      default:
        return "send_future_order_" + signal.direction;
    }
  }

  async _routeToOkx(signal) {
    // OKX orders go through the MCP server
    // Write to a special OKX command queue file
    const okxCmd = {
      instId: signal.instrument,
      side: signal.direction === "buy" || signal.direction === "close_short" ? "buy" : "sell",
      posSide: signal.direction.includes("close")
        ? "long"
        : signal.direction === "buy"
          ? "long"
          : "short",
      ordType: "market",
      sz: String(signal.qty),
      strategy: signal.strategy,
      sentAt: new Date().toISOString(),
    };
    const okxFile = "D:\\群益及元大API\\CapitalHftService\\state\\hft_okx_command.json";
    await writeFile(okxFile, JSON.stringify(okxCmd, null, 2), "utf-8");
    console.log(`[OKX] → ${okxCmd.side}/${okxCmd.posSide} ${signal.instrument} sz=${okxCmd.sz}`);
    return { ok: true };
  }

  async _appendLog(entry) {
    try {
      await appendFile(SIGNAL_LOG, entry + "\n", "utf-8");
    } catch {}
  }
}
