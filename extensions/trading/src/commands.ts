import type { BrokerProvider, Position } from "./types.js";

// =============================================================================
// Auto-reply command handlers (bypass LLM)
// =============================================================================

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatPosition(p: Position): string {
  const pl = `${formatMoney(p.unrealizedPL)} (${formatPercent(p.unrealizedPLPercent)})`;
  return `${p.symbol}: ${p.qty} shares @ ${formatMoney(p.avgEntryPrice)} → ${formatMoney(p.currentPrice)} | P&L: ${pl}`;
}

export async function handlePortfolioCommand(provider: BrokerProvider): Promise<string> {
  const [account, positions] = await Promise.all([provider.getAccount(), provider.getPositions()]);

  const lines: string[] = [
    "📊 Portfolio Summary",
    `Equity: ${formatMoney(account.equity)}`,
    `Cash: ${formatMoney(account.cash)}`,
    `Buying Power: ${formatMoney(account.buyingPower)}`,
    `Day P&L: ${formatMoney(account.dayPL)} (${formatPercent(account.dayPLPercent)})`,
    "",
  ];

  if (positions.length === 0) {
    lines.push("No open positions.");
  } else {
    lines.push(`Positions (${positions.length}):`);
    for (const p of positions) {
      lines.push(`  ${formatPosition(p)}`);
    }
  }

  return lines.join("\n");
}

export async function handlePriceCommand(
  provider: BrokerProvider,
  symbol: string,
): Promise<string> {
  if (!symbol) {
    return "Usage: /price <SYMBOL>  (e.g., /price AAPL)";
  }

  const quote = await provider.getQuote(symbol);
  const sign = quote.change >= 0 ? "+" : "";
  return [
    `💰 ${quote.symbol}`,
    `Price: ${formatMoney(quote.lastPrice)}`,
    `Change: ${sign}${formatMoney(quote.change)} (${formatPercent(quote.changePercent)})`,
    quote.volume > 0 ? `Volume: ${quote.volume.toLocaleString("en-US")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
