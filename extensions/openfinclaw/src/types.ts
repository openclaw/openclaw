/**
 * Type definitions for strategy fork module.
 */

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
