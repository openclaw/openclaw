import type { TradingConfig } from "../config.js";
import type { AccountInfo, BrokerProvider, Position, Quote } from "../types.js";

// =============================================================================
// Alpaca Markets REST API Provider
// =============================================================================

export class AlpacaProvider implements BrokerProvider {
  readonly name = "alpaca";
  private readonly baseUrl: string;
  private readonly dataUrl = "https://data.alpaca.markets";
  private readonly headers: Record<string, string>;

  constructor(config: TradingConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("Alpaca provider requires apiKey and apiSecret");
    }

    this.baseUrl =
      config.baseUrl ??
      (config.paperTrading ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets");

    this.headers = {
      "APCA-API-KEY-ID": config.apiKey,
      "APCA-API-SECRET-KEY": config.apiSecret,
      Accept: "application/json",
    };
  }

  private async request<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const res = await fetch(url, {
      headers: headers ?? this.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Alpaca API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async getAccount(): Promise<AccountInfo> {
    const acc = await this.request<AlpacaAccount>(`${this.baseUrl}/v2/account`);
    const equity = Number(acc.equity);
    const lastEquity = Number(acc.last_equity);
    const dayPL = equity - lastEquity;
    return {
      equity,
      cash: Number(acc.cash),
      buyingPower: Number(acc.buying_power),
      portfolioValue: equity,
      dayPL,
      dayPLPercent: lastEquity !== 0 ? (dayPL / lastEquity) * 100 : 0,
    };
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.request<AlpacaPosition[]>(`${this.baseUrl}/v2/positions`);
    return positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      marketValue: Number(p.market_value),
      avgEntryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      unrealizedPL: Number(p.unrealized_pl),
      unrealizedPLPercent: Number(p.unrealized_plpc) * 100,
    }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const upper = symbol.toUpperCase();
    const isCrypto = upper.includes("/");

    let lastPrice: number;
    let volume: number;

    if (isCrypto) {
      const encoded = encodeURIComponent(upper);
      const data = await this.request<AlpacaCryptoQuote>(
        `${this.dataUrl}/v1beta3/crypto/us/latest/quotes?symbols=${encoded}`,
      );
      const quote = data.quotes?.[upper];
      if (!quote) {
        throw new Error(`No crypto quote found for ${upper}`);
      }
      lastPrice = (Number(quote.ap) + Number(quote.bp)) / 2;
      volume = 0; // Crypto quotes don't include volume in quote endpoint
    } else {
      const data = await this.request<AlpacaStockQuote>(
        `${this.dataUrl}/v2/stocks/${encodeURIComponent(upper)}/quotes/latest`,
      );
      lastPrice = (Number(data.quote.ap) + Number(data.quote.bp)) / 2;
      volume = 0; // Latest quote doesn't include volume; would need snapshot
    }

    // Try to get previous close for change calculation via snapshot
    let change = 0;
    let changePercent = 0;
    try {
      if (!isCrypto) {
        const snap = await this.request<AlpacaStockSnapshot>(
          `${this.dataUrl}/v2/stocks/${encodeURIComponent(upper)}/snapshot`,
        );
        const prevClose = Number(snap.prevDailyBar?.c ?? 0);
        if (prevClose > 0) {
          change = lastPrice - prevClose;
          changePercent = (change / prevClose) * 100;
        }
        volume = Number(snap.dailyBar?.v ?? 0);
      }
    } catch {
      // Snapshot may not be available for all symbols
    }

    return {
      symbol: upper,
      lastPrice: Math.round(lastPrice * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      volume,
    };
  }
}

// =============================================================================
// Alpaca API Response Types
// =============================================================================

type AlpacaAccount = {
  equity: string;
  cash: string;
  buying_power: string;
  last_equity: string;
  portfolio_value: string;
};

type AlpacaPosition = {
  symbol: string;
  qty: string;
  market_value: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
};

type AlpacaStockQuote = {
  quote: {
    ap: number; // ask price
    bp: number; // bid price
  };
};

type AlpacaCryptoQuote = {
  quotes?: Record<
    string,
    {
      ap: number;
      bp: number;
    }
  >;
};

type AlpacaStockSnapshot = {
  prevDailyBar?: { c: number };
  dailyBar?: { v: number };
};
