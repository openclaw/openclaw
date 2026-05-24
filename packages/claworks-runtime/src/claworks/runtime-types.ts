import type { ResearchAgent } from "../agents/research-agent.js";
import type { ConnectorManager } from "../interfaces/connectors/connector-manager.js";
import type { ActionRegistry } from "../kernel/action-registry.js";
import type { BridgeRegistry } from "../kernel/bridge-registry.js";
import type { CapabilityRegistry } from "../kernel/capability-registry.js";
import type { CardBuilder } from "../kernel/card-builder.js";
import type { ContextEngine } from "../kernel/context-engine.js";
import type { EventKernel } from "../kernel/event-kernel.js";
import type { EvolutionSyncManager } from "../kernel/evolution-sync.js";
import type { EvolveEngine } from "../kernel/evolve-engine.js";
import type { HookEngine } from "../kernel/hook-engine.js";
import type { IngressRouter } from "../kernel/ingress.js";
import type { IntentRegistry } from "../kernel/intent-registry.js";
import type { NotificationRouter } from "../kernel/notification-router.js";
import type { ConstitutionV2 } from "../kernel/robot-constitution-v2.js";
import type { RobotIdentityManager } from "../kernel/robot-identity-manager.js";
import type { RuleEngine } from "../kernel/rule-engine.js";
import type { ScaffoldEngine } from "../kernel/scaffold-engine.js";
import type { PlaybookScheduler } from "../kernel/scheduler.js";
import type { StructuredOutputEngine } from "../kernel/structured-output.js";
import type { RobotInfo, KnowledgeBase } from "../kernel/types.js";
import type { UserProfileStore } from "../kernel/user-profile-store.js";
import type { PackLoader, LoadedPack } from "../pack-loader/index.js";
import type { CbrStore } from "../planes/data/cbr-store.js";
import type { CwDatabase } from "../planes/data/db-types.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createOntologyEngine } from "../planes/data/ontology-engine.js";
import type { PlaybookEngine } from "../planes/orch/playbook-engine.js";
import type { LlmCompleteFn } from "../planes/orch/step-executor.js";
import type { ClaworksRobotConfig } from "./config-types.js";
import type { ModelRouter } from "./model-router.js";
import { createRbacGuard, type RobotIdentity } from "./robot-identity.js";

/** 运行时句柄（与 `createClaworksRuntime` 返回值结构一致）。 */
export type ClaworksRuntime = {
  config: ClaworksRobotConfig;
  robot: RobotInfo;
  identity: RobotIdentity;
  rbac: ReturnType<typeof createRbacGuard>;
  ingress: IngressRouter;
  db: CwDatabase;
  objectStore: ReturnType<typeof createObjectStore>;
  ontology: ReturnType<typeof createOntologyEngine>;
  kb: KnowledgeBase;
  playbookEngine: PlaybookEngine;
  kernel: EventKernel;
  /** 能力注册表，提供 register / invoke / list 等操作 */
  capabilities: CapabilityRegistry;
  /**
   * Playbook Action 注册表。
   * Pack entry.ts 通过 PackContribution.actionHandlers 注册，
   * step-executor 优先查此表，找不到再走通用 CRUD 兜底。
   */
  actionRegistry: ActionRegistry;
  /**
   * IM 意图注册表。
   * 各 Pack 通过 PackContribution.intentMappings 声明自己的 intent→event 映射，
   * 解耦 function-executor 的硬编码中央意图表。
   */
  intentRegistry: IntentRegistry;
  /** 行为准则（四层权限体系），extension capabilities 注册后设置 */
  constitution?: ConstitutionV2;
  /** 机器人身份管理器 */
  robotIdentityManager: RobotIdentityManager;
  /** 关闭运行时（停止 kernel、connector 等） */
  shutdown: () => Promise<void>;
  loadedPacks: LoadedPack[];
  packLoader: PackLoader;
  connectorManager: ConnectorManager;
  scheduler: PlaybookScheduler;
  /** LLM 模型路由（按任务类型选择模型） */
  modelRouter?: ModelRouter;
  logger?: (msg: string) => void;
  databaseDialect?: string;
  databaseNote?: string;
  _outboxFlushTimer?: ReturnType<typeof setInterval>;
  /** HITL expiry sweep timer (30 s interval). */
  _hitlExpiryTimer?: ReturnType<typeof setInterval>;
  /** AutonomyEngine 周期性扫描定时器（每5分钟检测学习机会） */
  _autonomyScanTimer?: ReturnType<typeof setInterval>;
  close: () => void;

  // ── 可选扩展组件（由 extension-capabilities 或上层注入）─────────────────

  /**
   * 桥接注册表（BridgeRegistry）：对接 LLM、通知、Subagent、Skill 等外部服务。
   * extension-capabilities 在初始化时调用 createBridgeRegistry() 并注入。
   */
  bridges?: BridgeRegistry;

  /**
   * LLM 补全函数（快捷访问，等同于 bridges?.get("llm")?.complete）。
   * 由 extension-capabilities 或宿主设置。
   */
  llmComplete?: LlmCompleteFn;

  /**
   * LLM 流式补全函数（当 LLM 支持 streaming 时设置）。
   */
  llmStream?: (params: {
    prompt: string;
    model?: string;
    signal?: AbortSignal;
  }) => AsyncIterable<string>;

  /**
   * 对话上下文引擎（多轮会话记忆）。
   * 由 extension-capabilities 初始化并绑定。
   */
  contextEngine?: ContextEngine;

  /**
   * 用户画像存储（记忆用户偏好风格、近期话题、交互次数）。
   * 由 createClaworksRuntime 初始化并绑定。
   * perceive.intent 读取后注入 LLM prompt，实现个性化响应。
   */
  userProfileStore?: UserProfileStore;

  /**
   * 通知路由器（管理用户通知偏好和跨渠道分发）。
   * 由 extension-capabilities 初始化并绑定。
   */
  notificationRouter?: NotificationRouter;

  /**
   * 卡片构建器（将 CwCard DSL 渲染为各渠道格式）。
   * 由 extension-capabilities 初始化并绑定。
   */
  cardBuilder?: CardBuilder;

  /**
   * 自主进化引擎（LLM 生成 Playbook → 写文件 → 热重载 → 验证 → CBR 学习）。
   * 由宿主在 runtime 组装完成后初始化并注入。
   */
  evolveEngine?: EvolveEngine;

  /**
   * 脚手架引擎（强模型离线生成 Prompt/规则/Skill → 弱模型在线填空执行）。
   * 由 createClaworksRuntime 初始化并注入。
   */
  scaffoldEngine?: ScaffoldEngine;

  /**
   * 研究智能体（多源并行搜索 + LLM 综合分析）。
   * 由 createClaworksRuntime 初始化并注入。
   */
  researchAgent?: ResearchAgent;

  /**
   * 结构化输出引擎（强制 LLM 返回合规 JSON）。
   * 由 extension-capabilities 或宿主注入。
   */
  structuredOutput?: StructuredOutputEngine;

  /**
   * 提示词模板注册表（存储和渲染 prompt 模板）。
   * 由宿主注入；未注入时相关能力降级为内联 prompt。
   */
  promptRegistry?: {
    list(): Array<{ id: string; template: string; description?: string }>;
    render(id: string, variables?: Record<string, unknown>): string;
    register(id: string, template: string, description?: string): void;
  };

  /**
   * 案例库（Case-Based Reasoning Store）。
   * 用于存储和检索历史处理案例，支持类比推理。
   * 由宿主或专项 Pack 注入。
   */
  cbrStore?: CbrStore;

  /**
   * Hook 引擎（生命周期钩子注册）。
   * 支持在 Playbook/事件处理的关键节点注入自定义逻辑。
   * 由宿主注入。
   */
  hookEngine?: HookEngine;

  /**
   * Provider 注册表（模型/服务提供者管理）。
   * 由宿主注入；与 OpenClaw 插件系统的 provider registry 对应。
   */
  providerRegistry?: {
    list(kind?: string): Array<{
      id: string;
      kind: string;
      name?: string;
      priority?: number;
      available?: boolean;
      meta?: Record<string, unknown>;
      [k: string]: unknown;
    }>;
    isAvailable(id: string): boolean;
    register(provider: Record<string, unknown>): void;
  };

  /**
   * 脚本库（ClaWorks 内置纯代码脚本，不依赖 LLM）。
   * 由 createClaworksRuntime 初始化；Playbook kind:script 步骤经此调用。
   *
   * @note 命名约定：Script = ClaWorks TS 脚本；Skill = OpenClaw ClawHub AI 能力（SKILL.md）
   */
  scriptLibrary?: {
    list(): Array<{ id: string; name: string; description?: string }>;
    get(id: string): Record<string, unknown> | undefined;
    invoke(id: string, params?: Record<string, unknown>): Promise<unknown>;
    register(script: Record<string, unknown>): void;
    /** Pack onLoad 时批量注册脚本；id 不含 "." 时自动添加 `{packId}.` 前缀 */
    registerFromPack(
      packId: string,
      scripts: Array<{
        id: string;
        name: string;
        description?: string;
        run: (params: unknown, runtime?: unknown) => unknown | Promise<unknown>;
      }>,
    ): void;
  };

  /**
   * @deprecated 使用 scriptLibrary；此字段仅保留向后兼容
   */
  skillLibrary?: {
    list(): Array<{ id: string; name: string; description?: string }>;
    get(id: string): Record<string, unknown> | undefined;
    invoke(id: string, params?: Record<string, unknown>): Promise<unknown>;
  };

  /**
   * OpenClaw ClawHub Skill 运行函数（AI 能力，有 LLM 推理）。
   * 由 claworks-robot bridge 注入；未注入时 skill.run 能力返回 not_available。
   *
   * @see createOpenClawSkillRunner in extensions/claworks-robot/runtime-bridge.ts
   */
  skillRun?: (args: { skillId: string; input: Record<string, unknown> }) => Promise<unknown>;

  /**
   * 规则引擎（基于声明式规则的决策支持）。
   * 由宿主注入；未注入时规则类能力不可用。
   */
  ruleEngine?: RuleEngine;

  /**
   * 离线进化同步管理器（导出机器人学习数据 → 在线生成进化包 → 导入改进成果）。
   * 由 createClaworksRuntime 初始化并注入。
   */
  evolutionSync?: EvolutionSyncManager;

  /**
   * 额外的可扩展运行时属性（由宿主或插件动态挂载）。
   * 类型为 unknown，调用者需自行断言。
   */
  [key: string]: unknown;
};
