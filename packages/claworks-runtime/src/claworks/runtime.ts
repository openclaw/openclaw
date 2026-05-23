import { homedir } from "node:os";
import { join } from "node:path";
import { createResearchAgent } from "../agents/research-agent.js";
import { ConnectorManager } from "../interfaces/connectors/connector-manager.js";
import { resolveConnectorConfigs } from "../interfaces/connectors/presets.js";
import { createActionRegistry } from "../kernel/action-registry.js";
import { createContextEngine } from "../kernel/context-engine.js";
import { createCoreCapabilityRegistry } from "../kernel/core-capabilities.js";
import { createEventKernel, type EventKernel } from "../kernel/event-kernel.js";
import { CW_EVENTS } from "../kernel/event-names.js";
import { EvolutionSyncManager } from "../kernel/evolution-sync.js";
import { createEvolveEngine } from "../kernel/evolve-engine.js";
import { registerExtensionCapabilities } from "../kernel/extension-capabilities.js";
import { createHookEngine } from "../kernel/hook-engine.js";
import { createIngressRouter, DEFAULT_INGRESS_POLICIES } from "../kernel/ingress.js";
import { createIntentRegistry } from "../kernel/intent-registry.js";
import {
  createConstitutionV2,
  DEFAULT_OPERATOR_CONSTITUTION,
} from "../kernel/robot-constitution-v2.js";
import { createRobotIdentityManager } from "../kernel/robot-identity-manager.js";
import { createScaffoldEngine } from "../kernel/scaffold-engine.js";
import { createPlaybookScheduler } from "../kernel/scheduler.js";
import { createScriptLibrary, registerBuiltinScripts } from "../kernel/script-library.js";
import type { KnowledgeBase, RobotInfo } from "../kernel/types.js";
import { createUserProfileStore } from "../kernel/user-profile-store.js";
import { createPackLoader } from "../pack-loader/index.js";
import { createCbrStore } from "../planes/data/cbr-store.js";
import { openDatabase } from "../planes/data/db-open.js";
import { createFileKnowledgeBase } from "../planes/data/knowledge-base-file.js";
import { createKnowledgeBase } from "../planes/data/knowledge-base.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createOntologyEngine } from "../planes/data/ontology-engine.js";
import type { HitlGate } from "../planes/orch/hitl-gate.js";
import { createPlaybookEngine } from "../planes/orch/playbook-engine.js";
import type {
  LlmCompleteFn,
  NotifyFn,
  SkillRunFn,
  ScriptRunFn,
  SubagentRunFn,
} from "../planes/orch/step-executor.js";
import { createDirectLlmBridge } from "./direct-llm-bridge.js";
import { applyIngressPublish } from "./ingress-publish.js";
import { createModelRouter } from "./model-router.js";
import { appendObservationEvent, markRuntimeStarted } from "./observability.js";
import {
  applyPackContributions,
  loadPersistedInstalled,
  mergePackConfig,
  reloadClaworksPackById,
  reloadClaworksPacksFromDisk,
} from "./pack-runtime.js";
import { schedulePolicySync } from "./policy-sync.js";
import { isClaworksProductionMode } from "./product-env.js";
import {
  buildRobotIdentity,
  createRbacGuard,
  DEFAULT_RBAC_POLICIES,
  type RbacPolicy,
} from "./robot-identity.js";

export type { ClaworksRobotConfig } from "./config-types.js";
export type { ClaworksRuntime } from "./runtime-types.js";
import type { ClaworksRobotConfig } from "./config-types.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export async function createClaworksRuntime(
  config: ClaworksRobotConfig,
  opts?: {
    version?: string;
    logger?: (msg: string) => void;
    llmComplete?: LlmCompleteFn;
    notify?: NotifyFn;
    kb?: KnowledgeBase;
    hitl?: HitlGate;
    subagentRun?: SubagentRunFn;
    skillRun?: SkillRunFn;
  },
): Promise<ClaworksRuntime> {
  // 独立部署：外部未注入 llmComplete 时，自动探测直连 LLM（Ollama / OpenAI / Anthropic）
  // 企业私域只需设置 CLAWORKS_LLM_BASE_URL + CLAWORKS_LLM_API_KEY 即可，无需 OpenClaw
  if (!opts?.llmComplete) {
    const directBridge = createDirectLlmBridge({
      base_url: config.llm?.base_url,
      api_key: config.llm?.api_key,
      model: config.llm?.model,
    });
    if (directBridge) {
      opts = { ...opts, llmComplete: directBridge };
      opts?.logger?.("[claworks] 独立 LLM bridge 已启用（直连模式）");
    }
  }

  const dbUrl = config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`;
  const { db, close, dialect, note } = openDatabase(dbUrl);
  if (note) {
    opts?.logger?.(`[claworks] ${note}`);
  }

  const robot: RobotInfo = {
    name: config.robot?.name ?? "claworks-robot",
    role: config.robot?.role ?? "monolith",
    version: opts?.version ?? "2026.5.20",
    endpoint: `http://${config.robot?.host ?? "127.0.0.1"}:${config.robot?.port ?? 18_800}`,
  };

  const stateDir = join(homedir(), ".claworks");
  const identity = buildRobotIdentity({
    robotName: robot.name,
    robotRole: robot.role,
    stateDir,
  });

  const rbacPolicies: RbacPolicy[] = [...DEFAULT_RBAC_POLICIES];
  const rbac = createRbacGuard(rbacPolicies);
  const ingress = createIngressRouter(DEFAULT_INGRESS_POLICIES);

  const ontology = createOntologyEngine();
  const policySyncTarget: { runtime?: ClaworksRuntime } = {};
  const objectStore = createObjectStore(db, {
    validate: (typeName, data) => ontology.validate(typeName, data),
    onPolicyWrite: (typeName) => {
      if (policySyncTarget.runtime) {
        schedulePolicySync(policySyncTarget.runtime, typeName);
      }
    },
  });
  const kbPath = config.data?.kb_path?.trim();
  const kb =
    opts?.kb ??
    (kbPath && config.data?.kb_provider !== "memory-core"
      ? createFileKnowledgeBase(kbPath)
      : createKnowledgeBase());
  const hitl = opts?.hitl ?? (await import("../planes/orch/hitl-gate.js")).createHitlGate();

  let kernel!: EventKernel;
  let runtime!: ClaworksRuntime;

  const publishEvent = async (
    type: string,
    source: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ) => {
    appendObservationEvent(source, type, payload);
    await kernel.publish(type, source, payload, {
      correlationId,
      subjectType: "system",
      subjectId: source,
    });
  };

  const a2aPeers = config.a2a?.peers ?? [];

  const modelRouter = createModelRouter(config.model_router);

  // Create registries before playbook engine so they can be shared
  const actionRegistry = createActionRegistry();
  const intentRegistry = createIntentRegistry();

  // ScriptLibrary: 内置纯 TS 脚本（不依赖 LLM），供 kind:script Playbook 步骤调用
  const scriptLibrary = createScriptLibrary();

  // scriptRun: 优先调用内置 ScriptLibrary，找不到时返回 not_found（外部 skill 走 skillRun）
  const scriptRun: ScriptRunFn = async ({ scriptId, input }) => {
    return scriptLibrary.invoke(scriptId, input ?? {});
  };

  const productionMode = isClaworksProductionMode(config);

  const playbookEngine = createPlaybookEngine({
    db,
    objectStore,
    kb,
    robot,
    hitl,
    llmComplete: opts?.llmComplete,
    notify: opts?.notify,
    ontology,
    publishEvent,
    subagentRun: opts?.subagentRun,
    skillRun: opts?.skillRun,
    scriptRun,
    a2aPeers,
    modelRouter,
    rbacCheck: (input) => rbac.check(input),
    reloadPacks: async () => {
      const { packs } = await reloadClaworksPacksFromDisk(runtime);
      return {
        packs,
        total: packs.length,
        loaded: packs.length,
      };
    },
    reloadPackById: async (packId) => reloadClaworksPackById(runtime, packId),
    actionRegistry,
    intentRegistry,
    logger: opts?.logger,
    productionMode,
    // publishAnomaly 在 kernel 创建后通过 runtime.kernel.publish 实现，
    // 延迟绑定到 playbookEngine（engine 已支持热替换 deps）
  });

  const packLoader = createPackLoader();
  const packPaths = [
    ...(config.packs?.paths ?? []),
    join(homedir(), ".claworks", "packs"),
    join(process.cwd(), "packs"),
    join(process.cwd(), "../claworks-packs"),
  ];
  const persistedInstalled = await loadPersistedInstalled();
  const packConfig = mergePackConfig(
    {
      ...config.packs,
      paths: packPaths,
      installed: config.packs?.installed ?? [
        "base",
        "enterprise-foundation",
        "process-industry",
        "enterprise-general",
      ],
    },
    persistedInstalled,
  );
  config.packs = packConfig;
  const packs = await packLoader.loadInstalled(packConfig);

  await ontology.loadFromPacks(packs);
  await playbookEngine.loadFromPacks(packs);

  const gatewayPort = Number(process.env.CLAWORKS_GATEWAY_PORT ?? config.robot?.port ?? 18_800);
  robot.endpoint = `http://${config.robot?.host ?? "127.0.0.1"}:${gatewayPort}`;

  const publishAnomaly = async (payload: Record<string, unknown>) => {
    appendObservationEvent("kernel", "system.anomaly", payload);
    await kernel.publish("system.anomaly", "kernel", payload, {
      subjectType: "system",
      subjectId: "kernel",
    });
  };

  kernel = createEventKernel({
    playbookEngine,
    db,
    logger: opts?.logger,
    playbookConcurrency: config.kernel?.playbook_concurrency ?? 10,
    publishAnomaly,
    onOutboxExhausted: async (payload) => {
      await publishAnomaly({ kind: "outbox_exhausted", ...payload });
    },
  });
  kernel.matcher.load(playbookEngine.list());
  // 延迟绑定 publishAnomaly 到 playbookEngine（kernel 创建后才有完整引用）
  playbookEngine.setPublishAnomaly(publishAnomaly);

  const connectorManager = new ConnectorManager({ logger: opts?.logger });
  connectorManager.setEventHandler(async (ev) => {
    appendObservationEvent(ev.source, ev.type, ev.payload);
    const result = await applyIngressPublish(runtime, {
      source: "connector",
      eventType: ev.type,
      subjectId: ev.source,
      payload: ev.payload,
      correlationId: ev.correlationId,
      subjectType: "system",
      publishSource: ev.source,
    });
    if (result.action === "denied") {
      opts?.logger?.(`[claworks:ingress] denied connector event: ${ev.type} — ${result.reason}`);
      return;
    }
    if (result.action === "observe_only") {
      opts?.logger?.(`[claworks:ingress] observe-only: ${ev.type} from ${ev.source}`);
      return;
    }
    if (result.action === "intent_routed") {
      opts?.logger?.(
        `[claworks:ingress] intent_route ${ev.type} → playbook ${result.playbookId} run=${result.runId}`,
      );
    }
  });
  playbookEngine.setConnectorInvoke(async (connectorId, method, params) => {
    await connectorManager.invoke(connectorId, method, params);
  });

  const scheduler = createPlaybookScheduler({
    logger: opts?.logger,
    timezone: config.kernel?.scheduler_timezone,
    onFire: async (playbookId) => {
      await kernel.publish("system.schedule.fired", "scheduler", {
        playbook_id: playbookId,
        _scheduled: true,
        fired_at: new Date().toISOString(),
      });
    },
  });
  scheduler.reload(playbookEngine.list());

  const robotIdentityManager = createRobotIdentityManager({
    name: robot.name,
    role: robot.role,
  });

  runtime = {
    config,
    robot,
    identity,
    rbac,
    ingress,
    db,
    objectStore,
    ontology,
    kb,
    playbookEngine,
    kernel,
    // Will be set after runtime is assembled
    capabilities: null as never,
    actionRegistry,
    intentRegistry,
    robotIdentityManager,
    shutdown: async () => stopClaworksRuntime(runtime),
    loadedPacks: packs,
    packLoader,
    connectorManager,
    scheduler,
    logger: opts?.logger,
    databaseDialect: dialect,
    close,
  };
  policySyncTarget.runtime = runtime;

  // 初始化脚本库并绑定 runtime（需在 runtime 对象创建后执行）
  registerBuiltinScripts(scriptLibrary, runtime);
  runtime.scriptLibrary = scriptLibrary as ClaworksRuntime["scriptLibrary"];
  // 向后兼容别名：skillLibrary → scriptLibrary
  runtime.skillLibrary = runtime.scriptLibrary;
  // OpenClaw ClawHub Skill bridge（AI 能力，由 claworks-robot 注入）
  if (opts?.skillRun) {
    runtime.skillRun = opts.skillRun;
  }

  // Create capability registry after runtime is fully assembled (it needs the runtime ref)
  const capabilities = createCoreCapabilityRegistry(runtime);
  runtime.capabilities = capabilities;
  kernel.setCapabilityRegistry(capabilities);

  // Register extension capabilities (L10-L36: reasoning, memory, comms, a2a, industrial, etc.)
  const constitutionConfig = (config.kernel as Record<string, unknown> | undefined) ?? {};
  const constitution = createConstitutionV2({
    autoAllow: Array.isArray(constitutionConfig.extra_auto_allow)
      ? [
          ...DEFAULT_OPERATOR_CONSTITUTION.autoAllow,
          ...(constitutionConfig.extra_auto_allow as string[]),
        ]
      : undefined,
    hitlRequired: Array.isArray(constitutionConfig.extra_hitl_required)
      ? [
          ...DEFAULT_OPERATOR_CONSTITUTION.hitlRequired,
          ...(constitutionConfig.extra_hitl_required as string[]),
        ]
      : undefined,
    deny: Array.isArray(constitutionConfig.extra_deny)
      ? [...DEFAULT_OPERATOR_CONSTITUTION.deny, ...(constitutionConfig.extra_deny as string[])]
      : undefined,
  });
  runtime.constitution = constitution;
  registerExtensionCapabilities(runtime, constitution);
  capabilities.setConstitution(constitution);

  // 初始化脚手架引擎（强模型离线预生成，弱模型在线填空执行）
  runtime.scaffoldEngine = createScaffoldEngine(runtime);

  // 初始化进化引擎（分析失败案例 → 提出 Playbook/能力改进建议 → 写入 Scaffold）
  runtime.evolveEngine = createEvolveEngine(runtime);

  // 初始化对话上下文引擎（多轮会话记忆，跨消息追踪对话历史）
  runtime.contextEngine = createContextEngine({
    llmComplete: opts?.llmComplete
      ? async (p) => {
          const r = await opts.llmComplete!(p.prompt);
          return { text: typeof r === "string" ? r : String(r) };
        }
      : undefined,
  });

  // 将对话上下文引擎绑定到 Playbook 引擎（延迟绑定，contextEngine 初始化在 playbookEngine 之后）
  // 效果：每次 Playbook 执行时自动注入 _session 变量（最近 10 轮对话历史）
  runtime.playbookEngine.setContextEngine(runtime.contextEngine);

  // 初始化用户画像存储（记忆用户偏好风格、近期话题，持久化到 SQLite）
  runtime.userProfileStore = createUserProfileStore(db);

  // 初始化研究智能体（多源并行搜索 + LLM 综合分析）
  runtime.researchAgent = createResearchAgent(runtime);

  // 初始化 Hook 引擎（生命周期钩子注册，支持 im_notify/webhook/playbook/a2a_delegate）
  runtime.hookEngine = createHookEngine();

  // 初始化 CBR 案例记忆（Case-Based Reasoning，存储历史成功案例供类比推理）
  runtime.cbrStore = createCbrStore();

  // 初始化离线进化同步管理器（导出进化数据包 / 导入进化包）
  runtime.evolutionSync = new EvolutionSyncManager(runtime);

  // 注册 Pack factory 贡献（action handlers / intent mappings / capabilities）
  await applyPackContributions(runtime, packs);

  return runtime;
}

export async function startClaworksRuntime(runtime: ClaworksRuntime): Promise<void> {
  markRuntimeStarted();
  await runtime.kernel.start();
  const hydrated = await runtime.playbookEngine.hydrateSuspendedRuns();
  if (hydrated > 0) {
    runtime.logger?.(`[claworks] hydrated ${hydrated} waiting_hitl run(s)`);
  }
  runtime.scheduler.reload(runtime.playbookEngine.list());
  // 启动时从 ObjectStore 同步 RBAC/Ingress 策略
  const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync.js");
  await syncRbacFromObjectStore(runtime);
  await syncIngressFromObjectStore(runtime);
  const connectorEntries = runtime.config.connectors ?? {};
  const connectors = resolveConnectorConfigs(connectorEntries);
  for (const [id, cfg] of Object.entries(connectors)) {
    await runtime.connectorManager.start(id, cfg);
    const raw = connectorEntries[id];
    if (raw?.auto_start) {
      const method =
        typeof raw.auto_start === "object" ? (raw.auto_start.method ?? "start") : "start";
      const params = typeof raw.auto_start === "object" ? raw.auto_start.params : undefined;
      try {
        await runtime.connectorManager.invoke(id, method, params);
      } catch (err) {
        runtime.logger?.(
          `[claworks:connector] auto_start ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  await runtime.kernel.flushOutbox();
  runtime._outboxFlushTimer = setInterval(() => {
    void runtime.kernel.flushOutbox().catch((err) => {
      runtime.logger?.(
        `[claworks:outbox] flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, 30_000);

  // HITL timeout sweep — auto-resolve expired approvals every 30 s
  runtime._hitlExpiryTimer = setInterval(() => {
    void runtime.playbookEngine
      .expireStaleHitl()
      .then((n) => {
        if (n > 0) {
          runtime.logger?.(`[claworks:hitl] expired ${n} stale HITL token(s)`);
        }
      })
      .catch((err) => {
        runtime.logger?.(
          `[claworks:hitl] expiry sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, 30_000);

  // Startup configuration health validation
  const startupWarnings = validateStartupConfig(runtime.config);
  if (startupWarnings.length > 0) {
    startupWarnings.forEach((w) => runtime.logger?.(`[ClaWorks Startup] ${w}`));
    await runtime.kernel
      .publish(CW_EVENTS.SYSTEM_STARTUP_WARNINGS, "runtime", { warnings: startupWarnings })
      .catch(() => {});
  }

  await runtime.kernel.publish(CW_EVENTS.SYSTEM_RUNTIME_STARTED, "runtime", {
    version: runtime.robot.version,
    name: runtime.robot.name,
    role: runtime.robot.role,
    packCount: runtime.loadedPacks.length,
    playbookCount: runtime.playbookEngine.list().length,
    endpoint: runtime.robot.endpoint,
    warnings: startupWarnings,
  });
  // system.startup is the Playbook-facing alias for system.runtime.started
  // (robot_identity_announce and similar Playbooks subscribe to system.startup)
  await runtime.kernel.publish(CW_EVENTS.SYSTEM_STARTUP, "runtime", {
    version: runtime.robot.version,
    name: runtime.robot.name,
    role: runtime.robot.role,
    packCount: runtime.loadedPacks.length,
    playbookCount: runtime.playbookEngine.list().length,
  });
}

function validateStartupConfig(config: ClaworksRobotConfig): string[] {
  const warnings: string[] = [];
  const isProduction = isClaworksProductionMode(config);
  const tag = isProduction ? "[PRODUCTION]" : "[DEV]";

  if (!config.model_router?.complete && !config.model_router?.fast) {
    warnings.push(`${tag} LLM bridge 未配置，意图分类和 LLM 步骤将不可用`);
  }
  if (!config.notify?.targets || config.notify.targets.length === 0) {
    warnings.push(`${tag} Notify bridge 未配置，主动推送消息将不可用`);
  }
  if (!config.data?.database_url) {
    warnings.push(`${tag} 数据库路径未配置，将使用默认路径 ~/.claworks/robot.db`);
  }
  if (!config.robot?.name) {
    warnings.push(`${tag} robot.name 未配置，使用默认名称 claworks-robot`);
  }

  // ── 生产模式安全检查 ────────────────────────────────────────────────────
  if (isProduction) {
    if (!config.api?.api_key?.trim()) {
      warnings.push(
        "[PRODUCTION][SECURITY] api.api_key 未配置 — 所有请求均以 system 主体授权，建议设置 Bearer token 或 CLAWORKS_INIT_SECURE=1",
      );
    }
    if (config.api?.require_api_key !== true) {
      warnings.push(
        "[PRODUCTION][SECURITY] api.require_api_key 未设为 true — 生产环境建议强制要求 API key",
      );
    }
    const kbProvider = config.data?.kb_provider ?? "stub";
    if (kbProvider === "stub") {
      warnings.push(
        "[PRODUCTION][QUALITY] KB 使用 in-memory stub（子串匹配），知识检索准确率低 — 建议 data.kb_provider=memory-core + CLAWORKS_VECTOR_KB=1",
      );
    }
    const dbUrl = config.data?.database_url ?? "";
    if (!dbUrl.startsWith("postgres")) {
      warnings.push(
        "[PRODUCTION][RELIABILITY] 数据库未配置 PostgreSQL — 生产环境建议使用 PG 以避免 SQLite 并发/容量限制",
      );
    }
    if (!config.a2a?.peers || config.a2a.peers.length === 0) {
      // 仅提示，不强制——单机器人部署不需要 A2A
    }
    if (config.security?.require_https_a2a !== true && (config.a2a?.peers?.length ?? 0) > 0) {
      warnings.push(
        "[PRODUCTION][SECURITY] A2A peers 已配置，但 security.require_https_a2a 未启用 — 建议强制 HTTPS A2A 连接",
      );
    }
  }

  return warnings;
}

export async function stopClaworksRuntime(runtime: ClaworksRuntime): Promise<void> {
  if (runtime._outboxFlushTimer) {
    clearInterval(runtime._outboxFlushTimer);
    runtime._outboxFlushTimer = undefined;
  }
  if (runtime._hitlExpiryTimer) {
    clearInterval(runtime._hitlExpiryTimer);
    runtime._hitlExpiryTimer = undefined;
  }
  try {
    await runtime.kernel.publish("system.runtime.stopped", "runtime", {
      name: runtime.robot.name,
    });
  } catch {
    // kernel may already be stopping
  }
  runtime.scheduler.stop();
  await runtime.connectorManager.stopAll();
  await runtime.kernel.stop();
  runtime.close();
}
