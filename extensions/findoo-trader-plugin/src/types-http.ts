/**
 * Shared HTTP type aliases and helper functions used across fin-core route handlers.
 */

// ── HTTP request/response type aliases ──

export type HttpReq = {
  on: (event: string, cb: (data?: Buffer) => void) => void;
  method?: string;
};

export type HttpRes = {
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: (body?: string) => void;
};

// ── Service type aliases for cross-plugin consumption ──

export type PaperEngineLike = {
  listAccounts: () => Array<{ id: string; name: string; equity: number }>;
  getAccountState: (id: string) => {
    id: string;
    name: string;
    initialCapital: number;
    cash: number;
    equity: number;
    positions: Array<{
      symbol: string;
      side: string;
      quantity: number;
      entryPrice: number;
      currentPrice: number;
      unrealizedPnl: number;
    }>;
    orders: Array<{
      id: string;
      symbol: string;
      side: string;
      type: string;
      quantity: number;
      fillPrice?: number;
      commission?: number;
      status: string;
      strategyId?: string;
      createdAt: number;
      filledAt?: number;
    }>;
  } | null;
  getSnapshots: (id: string) => Array<{
    timestamp: number;
    equity: number;
    cash: number;
    positionsValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
  }>;
  getOrders: (
    id: string,
    limit?: number,
  ) => Array<{
    id: string;
    symbol: string;
    side: string;
    type: string;
    quantity: number;
    fillPrice?: number;
    commission?: number;
    status: string;
    strategyId?: string;
    createdAt: number;
    filledAt?: number;
  }>;
};

export type StrategyRegistryLike = {
  list: (filter?: { level?: string }) => Array<{
    id: string;
    name: string;
    level: string;
    status?: string;
    lastBacktest?: {
      totalReturn: number;
      sharpe: number;
      sortino: number;
      maxDrawdown: number;
      winRate: number;
      profitFactor: number;
      totalTrades: number;
      finalEquity: number;
      initialCapital: number;
      strategyId: string;
    };
  }>;
  get?: (id: string) => { id: string; name: string; level: string; status?: string; definition?: Record<string, unknown>; symbol?: string } | undefined;
  updateLevel?: (id: string, level: string) => void;
  updateStatus?: (id: string, status: string) => void;
  updateBacktest?: (id: string, result: Record<string, unknown>) => void;
};

export type FundManagerLike = {
  getState: () => {
    allocations: Array<{ strategyId: string; capitalUsd: number; weightPct: number }>;
    totalCapital: number;
  };
};

export type BacktestEngineLike = {
  run: (
    definition: Record<string, unknown>,
    ohlcv: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
    config?: Record<string, unknown>,
  ) => {
    totalReturn: number;
    sharpe: number;
    sortino: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    finalEquity: number;
    initialCapital: number;
    strategyId: string;
  };
};

export type DataProviderLike = {
  getOHLCV: (
    symbol: string,
    timeframe: string,
    limit?: number,
  ) => Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>>;
};

export type AlertEngineLike = {
  addAlert: (
    condition: {
      kind: string;
      symbol?: string;
      price?: number;
      threshold?: number;
      direction?: string;
    },
    message?: string,
  ) => string;
  removeAlert: (id: string) => boolean;
  listAlerts: () => Array<{
    id: string;
    condition: Record<string, unknown>;
    createdAt: string;
    triggeredAt?: string;
    notified: boolean;
    message?: string;
  }>;
};

// ── Runtime services accessor ──

export type RuntimeServices = { services?: Map<string, unknown> };

// ── HTTP helper functions ──

export function parseJsonBody(req: HttpReq): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      if (chunk) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", () => reject(new Error("Request error")));
  });
}

export function jsonResponse(res: HttpRes, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function errorResponse(res: HttpRes, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}
