/**
 * Type definitions for FEP v2.0 strategy packages.
 * @module openfinclaw/types
 */

/** FEP 协议版本 */
export type FepVersion = "2.0";

/** 策略风格 */
export type FepV2Style =
  | "trend"
  | "mean-reversion"
  | "momentum"
  | "value"
  | "growth"
  | "breakout"
  | "rotation"
  | "hybrid";

/** K线周期 */
export type FepV2Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

/** FEP v2.0 identity 配置 */
export interface FepV2Identity {
  id: string;
  name: string;
  type?: string;
  version?: string;
  style?: FepV2Style;
  visibility?: "public" | "private" | "unlisted";
  summary?: string;
  description?: string;
  tags?: string[];
  license?: string;
  author?: {
    name?: string;
    wallet?: string;
  };
  changelog?: Array<{
    version: string;
    date: string;
    changes: string;
  }>;
}

/** FEP v2.0 technical 配置 */
export interface FepV2Technical {
  language?: string;
  entryPoint?: string;
}

/** FEP v2.0 多标的配置 */
export interface FepV2Universe {
  symbols: string[];
}

/** FEP v2.0 再平衡配置 */
export interface FepV2Rebalance {
  frequency: "daily" | "weekly" | "monthly";
  maxHoldings?: number;
  weightMethod?: "equal" | "market_cap";
}

/** FEP v2.0 回测配置 */
export interface FepV2Backtest {
  symbol: string;
  timeframe?: FepV2Timeframe;
  defaultPeriod: {
    startDate: string;
    endDate: string;
  };
  initialCapital: number;
  universe?: FepV2Universe;
  rebalance?: FepV2Rebalance;
}

/** FEP v2.0 风控配置 */
export interface FepV2Risk {
  maxDrawdownThreshold?: number;
  dailyLossLimitPct?: number;
  maxTradesPerDay?: number;
}

/** FEP v2.0 模拟盘配置 */
export interface FepV2Paper {
  barIntervalSeconds?: number;
  maxDurationHours?: number;
  warmupBars?: number;
  timeframe?: FepV2Timeframe;
}

/** FEP v2.0 策略参数 */
export interface FepV2Parameter {
  name: string;
  default: string | number | boolean;
  type: "integer" | "number" | "string" | "boolean";
  label?: string;
  range?: {
    min?: number;
    max?: number;
    step?: number;
  };
}

/** FEP v2.0 classification 配置 */
export interface FepV2Classification {
  archetype?: "systematic" | "discretionary" | "hybrid";
  market?: "Crypto" | "US" | "CN" | "HK" | "Forex" | "Commodity";
  assetClasses?: string[];
  frequency?: "daily" | "weekly" | "monthly";
  riskProfile?: "low" | "medium" | "high";
}

/** FEP v2.0 完整配置 */
export interface FepV2Config {
  fep: FepVersion;
  identity: FepV2Identity;
  technical?: FepV2Technical;
  parameters?: FepV2Parameter[];
  backtest: FepV2Backtest;
  risk?: FepV2Risk;
  paper?: FepV2Paper;
  classification?: FepV2Classification;
}

// ─────────────────────────────────────────────────────────────
// FEP v2.0 回测结果类型 (TaskResultData)
// ─────────────────────────────────────────────────────────────

/** 回测核心指标 */
export interface BacktestCoreMetrics {
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
}

/** 回测收益分析 */
export interface BacktestReturnAnalysis {
  sortino: number;
  annualizedReturn: number;
  calmar: number;
  returnsVolatility: number;
  riskReturnRatio: number;
}

/** 回测交易分析 */
export interface BacktestTradeAnalysis {
  expectancy: number;
  avgWinner: number;
  avgLoser: number;
  maxWinner: number;
  maxLoser: number;
  longRatio: number;
}

/** 回测扩展指标 */
export interface BacktestExtendedMetrics {
  pnlTotal: number;
  startingBalance: number;
  endingBalance: number;
  backtestStart: string;
  backtestEnd: string;
  totalOrders: number;
}

/** 权益曲线数据点 */
export interface EquityCurvePoint {
  date: string;
  equity: number;
}

/** 回撤曲线数据点 */
export interface DrawdownCurvePoint {
  date: string;
  drawdown: number;
}

/** 月度收益数据点 */
export interface MonthlyReturnPoint {
  month: string;
  return: number;
}

/** 交易记录 */
export interface TradeRecord {
  open_date: string;
  close_date: string;
  side: string;
  quantity: number;
  avg_open: number;
  avg_close: number;
  realized_pnl: string;
  return_pct: number;
}

/** 完整回测性能数据 */
export interface BacktestPerformance {
  core?: BacktestCoreMetrics;
  returns?: BacktestReturnAnalysis;
  trades?: BacktestTradeAnalysis;
  extended?: BacktestExtendedMetrics;
  hints?: string[];
  /** @deprecated 使用 equityCurve */
  monthlyReturns?: Record<string, number> | MonthlyReturnPoint[];
  recentValidation?: {
    decay?: {
      sharpeDecay30d: number;
      sharpeDecay90d: number;
      warning?: string;
    };
    recent?: Array<{
      period?: string;
      window?: string;
      sharpe?: number;
      finalEquity?: number;
      maxDrawdown?: number;
      totalReturn?: number;
      totalTrades?: number;
    }>;
    historical?: {
      period?: string;
      sharpe?: number;
      finalEquity?: number;
      maxDrawdown?: number;
      totalReturn?: number;
      totalTrades?: number;
    };
  };
}

/** 完整回测结果 (TaskResultData) */
export interface BacktestResult {
  alpha?: number | null;
  taskId?: string;
  metadata?: {
    id?: string;
    name?: string;
    tags?: string[];
    type?: string;
    style?: string;
    author?: { name?: string };
    market?: string;
    license?: string;
    summary?: string;
    version?: string;
    archetype?: string;
    frequency?: string;
    riskLevel?: string;
    visibility?: string;
    description?: string;
    assetClasses?: string[];
    parameters?: FepV2Parameter[];
  };
  integrity?: {
    fepHash?: string;
    codeHash?: string;
    contentCID?: string;
    contentHash?: string;
    publishedAt?: string;
    timestampProof?: string;
  };
  performance?: BacktestPerformance;
  equityCurve?: EquityCurvePoint[];
  drawdownCurve?: DrawdownCurvePoint[];
  monthlyReturns?: MonthlyReturnPoint[];
  trades?: TradeRecord[];
  /** @deprecated 使用 equityCurve */
  equity_curve?: unknown;
  /** @deprecated 使用 trades */
  trade_journal?: unknown;
}

/** Fork 元数据（存储在 .fork-meta.json） */
export interface ForkMeta {
  sourceId: string;
  sourceShortId: string;
  sourceName: string;
  sourceVersion: string;
  sourceAuthor?: string;
  forkedAt: string;
  forkDateDir: string;
  hubUrl: string;
  localPath: string;
  forkEntryId?: string;
  forkEntrySlug?: string;
}

/** 创建元数据（存储在 .created-meta.json） */
export interface CreatedMeta {
  name: string;
  displayName?: string;
  createdAt: string;
  createDateDir: string;
  localPath: string;
  versions?: CreatedVersion[];
}

/** 已发布版本记录 */
export interface CreatedVersion {
  version: string;
  publishedAt: string;
  hubId: string;
  hubSlug?: string;
}

/** 本地策略信息 */
export interface LocalStrategy {
  name: string;
  displayName: string;
  localPath: string;
  dateDir: string;
  type: "forked" | "created";
  sourceId?: string;
  createdAt: string;
  performance?: StrategyPerformance;
}

/** 策略绩效指标 */
export interface StrategyPerformance {
  totalReturn?: number;
  sharpe?: number;
  maxDrawdown?: number;
  winRate?: number;
  totalTrades?: number;
}

/** Hub 公开策略详情（GET /api/v1/skill/public/{id} 响应） */
export interface HubPublicEntry {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  summary?: string;
  type?: string;
  tags?: string[];
  version: string;
  visibility: "public" | "private" | "unlisted";
  tier?: string;
  author?: {
    id?: string;
    slug?: string;
    displayName?: string;
    verified?: boolean;
  };
  stats?: {
    fcsScore?: number;
    forkCount?: number;
    downloadCount?: number;
    viewCount?: number;
  };
  backtestResult?: {
    sharpe?: number;
    totalReturn?: number;
    maxDrawdown?: number;
    winRate?: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

/** Hub 策略详情（兼容旧类型） */
export type HubStrategyInfo = HubPublicEntry;

/** Fork 并下载响应（POST /api/v1/skill/entries/{id}/fork-and-download） */
export interface ForkAndDownloadResponse {
  success: boolean;
  entry: {
    id: string;
    slug?: string;
    name: string;
    version: string;
  };
  parent: {
    id: string;
    slug?: string;
    name: string;
  };
  download: {
    url: string;
    filename: string;
    expiresInSeconds: number;
    contentHash?: string;
  };
  forkedAt: string;
  creditsEarned?: {
    action: string;
    amount: number;
    message?: string;
  };
}

/** Fork 配置 */
export interface ForkConfig {
  keepGenes?: boolean;
  overrideParams?: Record<string, unknown>;
}

/** Fork 选项 */
export interface ForkOptions {
  targetDir?: string;
  dateDir?: string;
  skipConfirm?: boolean;
  name?: string;
  slug?: string;
  description?: string;
  keepGenes?: boolean;
}

/** Fork 结果 */
export interface ForkResult {
  success: boolean;
  localPath: string;
  sourceId: string;
  sourceShortId: string;
  sourceName: string;
  sourceVersion: string;
  forkEntryId?: string;
  forkEntrySlug?: string;
  creditsEarned?: {
    action: string;
    amount: number;
    message?: string;
  };
  error?: string;
}

/** 列表选项 */
export interface ListOptions {
  json?: boolean;
  dateDir?: string;
}

/** Skill API 配置 */
export interface SkillApiConfig {
  baseUrl: string;
  apiKey: string | undefined;
  requestTimeoutMs: number;
}

/** 榜单类型 */
export type BoardType = "composite" | "returns" | "risk" | "popular" | "rising";

/** 排行榜策略项 */
export interface LeaderboardStrategy {
  id: string;
  slug: string;
  name: string;
  description?: string;
  market?: string;
  style?: string;
  riskLevel?: string;
  author?: {
    slug?: string;
    displayName?: string;
    verified?: boolean;
    isAgent?: boolean;
  };
  publishedDays?: number;
  subscribers?: number;
  performance?: {
    returnSincePublish?: number;
    sharpeRatio?: number;
    maxDrawdown?: number;
    winRate?: number;
  };
  scores?: {
    composite?: number;
    returns?: number;
    risk?: number;
    popular?: number;
  };
  boardRanks?: {
    composite?: { rank: number; rankDelta?: number };
    returns?: { rank: number; rankDelta?: number };
    risk?: { rank: number; rankDelta?: number };
    popular?: { rank: number; rankDelta?: number };
    rising?: { rank: number; rankDelta?: number };
  };
  rank: number;
  rankDelta?: number;
  isNewEntry?: boolean;
  hotLabel?: string | null;
}

/** 排行榜响应 */
export interface LeaderboardResponse {
  board: string;
  strategies: LeaderboardStrategy[];
  total: number;
  cachedAt: string;
}
