/** 健康检查响应 */
export interface HealthResponse {
  status: string;
  version: string;
}

/** Playbook 触发响应 */
export interface TriggerPlaybookResponse {
  runId: string;
}

/** 知识库搜索结果条目 */
export interface KbSearchResult {
  id: string;
  content: string;
  score: number;
}

/** 机器人状态响应（对应 observe.robot_status 能力 + GET /v1/robot/status） */
export interface RobotStatusResponse {
  robot_name: string;
  robot_id: string;
  uptime_seconds: number;
  health: string;
  active_playbooks: number;
  kb_entries: number;
  capabilities_registered: number;
  loaded_packs?: number;
}

/** 事件发布响应 */
export interface PublishEventResponse {
  published: boolean;
}

/** 能力调用响应（泛型） */
export interface CapabilityCallResponse<T = unknown> {
  result: T;
}

/** 健康维度详情 */
export interface HealthDimension {
  id: string;
  label: string;
  status: string;
  enabled: boolean;
}

/** 健康维度聚合响应 */
export interface HealthDimensionsResponse {
  dimensions: HealthDimension[];
  overall: string;
}

/** Playbook 运行状态 */
export interface PlaybookRun {
  id: string;
  playbook_id: string;
  status: "running" | "completed" | "failed" | "pending";
  started_at?: string;
  completed_at?: string;
  error?: string | null;
}
