import type { ConnectorConfigInput } from "../interfaces/connectors/presets.js";
import type { RobotInfo } from "../kernel/types.js";
import type { CwPackConfig } from "../pack-loader/index.js";
import type { A2aPeerConfig } from "./a2a-peers.js";
import type { ClaworksNotifyConfig } from "./notify-types.js";

export type ClaworksRobotConfig = {
  /**
   * 生产模式开关。
   * - true：无 LLM/skill bridge 时 Playbook stub 步骤直接抛错（fail-closed），
   *   未配置 API key 时启动警告升级为错误。
   * - false（默认）：offline/dev 友好，stub 步骤记录日志后继续。
   * 可由 CLAWORKS_PRODUCTION=1 环境变量覆盖。
   */
  production_mode?: boolean;
  api?: {
    api_key?: string;
    /** 是否要求 API key（默认 false；生产模式建议设为 true） */
    require_api_key?: boolean;
    /** MCP 接口是否单独要求认证（默认与 REST 一致） */
    mcp_require_auth?: boolean;
  };
  /** 安全策略（请求过滤、IP 白名单等） */
  security?: {
    allowed_origins?: string[];
    ip_whitelist?: string[];
    /** 是否强制 HTTPS A2A peer 连接（默认 false；生产建议 true） */
    require_https_a2a?: boolean;
    /** 最大请求体大小（bytes，默认 1 MB） */
    max_body_bytes?: number;
    [key: string]: unknown;
  };
  a2a?: {
    enabled?: boolean;
    endpoint?: string;
    peers?: A2aPeerConfig[];
  };
  kernel?: {
    event_queue_size?: number;
    playbook_concurrency?: number;
    hitl_timeout_seconds?: number;
    scheduler_timezone?: string;
    /** 速率限制：最大请求数（滑动窗口） */
    rate_limit_max_requests?: number;
    /** 速率限制窗口时长（ms） */
    rate_limit_window_ms?: number;
  };
  robot?: {
    name?: string;
    role?: RobotInfo["role"];
    port?: number;
    host?: string;
    session_key?: string;
    /** 组织/企业名称 */
    organization?: string;
    /** 业务领域（如 "oil-gas", "manufacturing"） */
    domain?: string;
    /** 机器人归属用户 ID */
    owner_user_id?: string;
    /** 机器人归属用户名 */
    owner_name?: string;
    /** 是否启用主动通知（proactive messaging） */
    proactive?: boolean;
    /** 机器人界面语言（zh-CN / en-US 等） */
    language?: string;
    /** 是否启用自动学习（从对话中积累知识） */
    auto_learn?: boolean;
    /**
     * 自主巡逻间隔（毫秒，默认 300000 = 5分钟）。
     * 设为 0 禁用巡逻。巡逻触发 robot.patrol 事件，
     * Pack 通过 trigger.event = "robot.patrol" 的 Playbook 响应。
     */
    patrol_interval_ms?: number;
  };
  data?: {
    database_url?: string;
    kb_path?: string;
    kb_provider?: "stub" | "memory-core";
    memory_agent_id?: string;
    /** 知识库嵌入模型 ID */
    kb_embed_model?: string;
    /** 知识库监控目录（自动 ingest） */
    kb_watch_dirs?: string[];
    /** 知识库命名空间 */
    kb_namespace?: string;
    /** 知识库监控间隔（ms） */
    kb_watch_interval_ms?: number;
  };
  packs?: CwPackConfig;
  im_bridge?: {
    auto_on_message_received?: boolean;
  };
  notify?: ClaworksNotifyConfig;
  model_router?: {
    default?: string;
    fast?: string;
    embed?: string;
    /** 对话模型（chat completion） */
    chat?: string;
  };
  /**
   * 独立部署直连 LLM 配置（不依赖 OpenClaw/claworks-robot）。
   * 支持任意 OpenAI 兼容接口（Ollama / Qwen / DeepSeek / LocalAI 等）。
   *
   * 企业私域最小配置：
   *   llm:
   *     base_url: http://gpu-server:11434/v1
   *     model: qwen2.5:14b
   *
   * 如果不设置，运行时自动探测环境变量：
   *   CLAWORKS_LLM_BASE_URL / CLAWORKS_LLM_API_KEY / CLAWORKS_LLM_MODEL
   *   OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_BASE_URL
   */
  llm?: {
    /** OpenAI 兼容 Base URL（如 http://localhost:11434/v1） */
    base_url?: string;
    /** API Key（本地 Ollama 可留空） */
    api_key?: string;
    /** 模型名称（如 qwen2.5:14b / gpt-4o-mini / claude-3-5-haiku-20241022） */
    model?: string;
  };
  connectors?: Record<string, ConnectorConfigInput>;
};
