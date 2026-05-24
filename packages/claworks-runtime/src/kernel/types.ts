/** ClaWorks kernel shared types. */

export interface CwEvent {
  id: string;
  type: string;
  source: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  correlationId?: string;
  /** 触发主体标识（REST apikey hash、A2A peer name、channel user id、system） */
  subjectId?: string;
  /** 触发主体类型 */
  subjectType?: "agent" | "peer" | "apikey" | "channel_user" | "system";
  /** 幂等键（防重放） */
  idempotencyKey?: string;
}

export interface CwEventMatch {
  event: CwEvent;
  playbookId: string;
  priority: number;
  input: Record<string, unknown>;
}

export interface EventQueryOptions {
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export type EventTrigger =
  | { kind: "event"; pattern: string; filter?: Record<string, unknown>; condition?: string }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "manual" };

export interface RobotInfo {
  /** 机器人实例 ID；未配置时回退为 name */
  id?: string;
  name: string;
  role: "monolith" | "twin" | "ops" | "nexus";
  version: string;
  endpoint: string;
}

export interface KbResult {
  id: string;
  score: number;
  /** 主要文本字段 */
  text: string;
  /** text 的别名（向后兼容旧代码中使用 .content 的地方） */
  content?: string;
  /** 文档标题（可选） */
  title?: string;
  source?: string;
  namespace?: string;
  /** 文档 ID（向量知识库中的父文档） */
  document_id?: string;
  /** 文档分块 ID */
  chunk_id?: string;
  /** 分层标识 */
  layer?: string;
  /** 引用信息（段落/节标题） */
  citation?: string;
  /** 文档版本 */
  revision?: number;
  /** 任意扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 写入知识库时的选项 */
export interface KbIngestOptions {
  namespace?: string;
  source?: string;
  title?: string;
  tags?: string[];
  document_id?: string;
  chunk_id?: string;
  /** 知识库分层标识（如 "system", "domain", "enterprise"） */
  layer?: string;
  /** 任意扩展选项 */
  [key: string]: unknown;
}

export interface KnowledgeBase {
  /** 语义搜索（兼容旧代码中调用 .search 的地方） */
  search(
    query: string,
    opts?: { limit?: number; namespace?: string; layer?: string },
  ): Promise<KbResult[]>;
  /** 语义搜索（和 search 等价，供需要显式区分的调用方使用） */
  semanticSearch?(
    query: string,
    opts?: { limit?: number; namespace?: string },
  ): Promise<KbResult[]>;
  /** 向知识库写入文本 */
  ingest(text: string, opts?: KbIngestOptions): Promise<void>;
  /** 添加结构化文档（add 是 ingest 的别名，兼容旧接口） */
  add?(doc: {
    id?: string;
    content: string;
    title?: string;
    source?: string;
    namespace?: string;
    tags?: string[];
  }): Promise<string>;
  /** 按 id 删除文档 */
  remove?(id: string): Promise<void>;
  /** 统计文档总数 */
  count?(): Promise<number>;
  /**
   * 将缓冲区内容刷写到持久化存储（对 memory-core 等内存 KB 有意义）。
   * 若 KB 不支持 flush 则为 no-op。
   */
  flush?(): Promise<void>;
  /** KB 提供者标识（如 "bm25-memory", "memory-core", "file"） */
  provider?: string;
  /** 是否支持向量 embedding（语义搜索） */
  supportsEmbedding?: boolean;
  describe?(): Promise<KbStatus>;
}

export interface KbStatus {
  provider: "bm25-memory" | "file" | "memory-core" | string;
  vector: boolean;
  kb_path?: string;
  kb_embed_model?: string;
  kb_drop_dir?: string;
  memory_slot?: string;
  document_count?: number;
  note?: string;
}
