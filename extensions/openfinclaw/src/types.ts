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

/** Hub 策略详情（API 响应） */
export interface HubStrategyInfo {
  id: string;
  name: string;
  slug?: string;
  version: string;
  author?: {
    name?: string;
    id?: string;
  };
  description?: string;
  tags?: string[];
  market?: string;
  visibility?: "public" | "private" | "unlisted";
  performance?: StrategyPerformance;
  createdAt?: string;
  updatedAt?: string;
  downloadCount?: number;
}

/** Fork 选项 */
export interface ForkOptions {
  targetDir?: string;
  dateDir?: string;
  skipConfirm?: boolean;
}

/** Fork 结果 */
export interface ForkResult {
  success: boolean;
  localPath: string;
  sourceId: string;
  sourceShortId: string;
  sourceName: string;
  sourceVersion: string;
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
