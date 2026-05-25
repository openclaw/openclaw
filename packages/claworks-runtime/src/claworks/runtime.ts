import { homedir } from "node:os";
import { join } from "node:path";
import { createResearchAgent } from "../agents/research-agent.js";
import { ConnectorManager } from "../interfaces/connectors/connector-manager.js";
import { resolveConnectorConfigs } from "../interfaces/connectors/presets.js";
import { createActionRegistry } from "../kernel/action-registry.js";
import { createAutonomyEngine } from "../kernel/autonomy-engine.js";
import { createBridgeRegistry, BRIDGE_SKILL } from "../kernel/bridge-registry.js";
import { createCardBuilder } from "../kernel/card-builder.js";
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
import { createNotificationRouter } from "../kernel/notification-router.js";
import { createPromptTemplateRegistry } from "../kernel/prompt-templates.js";
import {
  createConstitutionV2,
  DEFAULT_OPERATOR_CONSTITUTION,
} from "../kernel/robot-constitution-v2.js";
import { createRobotIdentityManager } from "../kernel/robot-identity-manager.js";
import { createRuleEngine, registerBuiltinDecisionTables } from "../kernel/rule-engine.js";
import { createScaffoldEngine } from "../kernel/scaffold-engine.js";
import { createPlaybookScheduler } from "../kernel/scheduler.js";
import { createScriptLibrary, registerBuiltinScripts } from "../kernel/script-library.js";
import { createStructuredOutputEngine } from "../kernel/structured-output.js";
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
import { registerEvolutionAutoPromoteHandler } from "./evolution-auto-promote.js";
import { discoverHarnessSkillsFromConfig } from "./harness-sync.js";
import { applyIngressPublish } from "./ingress-publish.js";
import { createRuntimeLogger } from "./logger.js";
import { createModelRouter } from "./model-router.js";
import { appendObservationEvent, markRuntimeStarted } from "./observability.js";
import { registerPackProfileEventHandler } from "./pack-profile.js";
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
  const log = createRuntimeLogger(opts?.logger);

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
      log.info("独立 LLM bridge 已启用（直连模式）");
    }
  }

  const dbUrl = config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`;
  const { db, close, dialect, note } = openDatabase(dbUrl);
  if (note) {
    log.info(note);
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
    traceparent?: string,
  ) => {
    appendObservationEvent(source, type, payload);
    await kernel.publish(type, source, payload, {
      correlationId,
      traceparent,
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
    // 每个事件发布后触发 HookEngine（事件推送 / IM 通知 / Webhook）
    // runtime 用懒引用（createEventKernel 早于 runtime 赋值，但 onEventPublished 在运行时调用）
    onEventPublished: (event) => {
      runtime.hookEngine
        ?.process(event.type, event.payload as Record<string, unknown>, async (t, s, p) => {
          await kernel.publish(t, s, p);
        })
        .catch((err: unknown) => {
          log.error("[claworks:hook] error", err);
        });
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
      log.warn(`[claworks:ingress] denied connector event: ${ev.type} — ${result.reason}`);
      return;
    }
    if (result.action === "observe_only") {
      log.info(`[claworks:ingress] observe-only: ${ev.type} from ${ev.source}`);
      return;
    }
    if (result.action === "intent_routed") {
      log.info(
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
    // 同时注册到 BRIDGE_SKILL，统一通过 bridges.get(BRIDGE_SKILL) 访问
    runtime.bridges?.register(BRIDGE_SKILL, {
      run: (p) => opts.skillRun!(p),
      list: async () => discoverHarnessSkillsFromConfig(),
    });
  }
  // 将 llmComplete 挂载到 runtime（供 structuredOutput 等延迟引用访问）
  if (opts?.llmComplete) {
    runtime.llmComplete = opts.llmComplete;
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
  runtime.playbookEngine.setCapabilityInvoke(
    async (capabilityId, params, stepCtx) => {
      const userId = String(params.user_id ?? stepCtx.variables.user_id ?? "").trim() || undefined;
      const capCtx = {
        source: "playbook",
        runId: stepCtx.runId,
        playbookId: stepCtx.playbookId,
        stepCtx,
        userId,
        subjectId: stepCtx.robot.name,
        subjectType: "system",
        correlationId: stepCtx.runId,
        invoke: async (id: string, p: Record<string, unknown>) =>
          runtime.capabilities.invoke(id, capCtx, p),
        logger: opts?.logger,
      };
      return runtime.capabilities.invoke(capabilityId, capCtx, params, {
        constitutionCheck: { source: "playbook", userId },
      });
    },
    (id) => runtime.capabilities.get(id) !== undefined,
  );

  // 从 ObjectStore 恢复 Tier 2 用户规则（重启持久性）
  try {
    const { items } = await runtime.objectStore.query("_ConstitutionUserRule", { limit: 500 });
    for (const item of items) {
      const entry =
        item as unknown as import("../kernel/robot-constitution-v2.js").UserConstitutionEntry &
          Record<string, unknown>;
      if (typeof entry.userId === "string" && entry.userId) {
        constitution.setUserRule(entry);
      }
    }
  } catch {
    // 表未初始化（首次启动）或 DB 不可用时静默忽略
  }

  // 初始化脚手架引擎（强模型离线预生成，弱模型在线填空执行）
  // 初始化规则引擎（SOP→规则表、业务决策条件表）
  const ruleEngine = createRuleEngine();
  registerBuiltinDecisionTables(ruleEngine);
  runtime.ruleEngine = ruleEngine;

  runtime.scaffoldEngine = createScaffoldEngine(runtime);

  // 初始化进化引擎（分析失败案例 → 提出 Playbook/能力改进建议 → 写入 Scaffold）
  runtime.evolveEngine = createEvolveEngine(runtime);

  // 初始化对话上下文引擎（多轮会话记忆，跨消息追踪对话历史）
  runtime.contextEngine = createContextEngine({
    llmComplete: opts?.llmComplete
      ? async (p) => {
          const r = await opts.llmComplete!({ prompt: p.prompt });
          return { text: typeof r === "string" ? r : String(r.text ?? r) };
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

  // 开启自动学习：失败的 Playbook run 自动写入 CbrStore，供未来 propose() 参考
  // 必须在 cbrStore 初始化之后，否则 startAutoLearning 会空操作
  const _stopAutoLearning = runtime.evolveEngine.startAutoLearning();
  const _stopDraftReview = runtime.evolveEngine.startDraftReviewPipeline();
  runtime.kernel.bus.subscribe(CW_EVENTS.SYSTEM_RUNTIME_STOPPED, async () => {
    _stopAutoLearning();
    _stopDraftReview();
  });

  runtime.evolutionSync = new EvolutionSyncManager(runtime);
  runtime.autonomyEngine = createAutonomyEngine(runtime);

  // 初始化桥接注册表（LLM / 通知 / Skill 等外部服务）
  runtime.bridges = createBridgeRegistry();
  // 将 llmComplete 同步注册到 bridges["llm"]，统一供所有组件访问
  if (runtime.llmComplete) {
    const fn = runtime.llmComplete;
    runtime.bridges.register("llm", { complete: (p) => fn(p) });
  }
  // 将 opts.notify 注册到 bridges["notify"]（comms.send 通过此路径发送消息）
  if (opts?.notify) {
    const notifyFn = opts.notify;
    runtime.bridges.register("notify", { send: (p) => notifyFn(p) });
  }

  // 初始化提示词模板注册表（内置 6 个弱模型脚手架模板，支持运行时扩展）
  // render() 适配：将 {system, user} 合并为单一 prompt 字符串
  const ptReg = createPromptTemplateRegistry();
  runtime.promptRegistry = {
    list: () =>
      ptReg.list().map((t) => ({ id: t.id, template: t.user, description: t.description })),
    render: (id, variables) => {
      const r = ptReg.render(id, (variables ?? {}) as Record<string, string>);
      return r.system ? `${r.system}\n\n${r.user}` : r.user;
    },
    register: (id, template, description) =>
      ptReg.register({
        id,
        name: id,
        description: description ?? id,
        user: template,
        system: "",
        outputFormat: "text",
      }),
  };

  runtime.playbookEngine.setRenderPromptTemplate((id, variables) => {
    const rendered = runtime.promptRegistry?.render(id, variables as Record<string, string>);
    return rendered?.trim() ? rendered : null;
  });

  // 初始化卡片构建器（飞书/企微/钉钉 富交互卡片渲染）
  runtime.cardBuilder = createCardBuilder();

  // 初始化通知路由器（用户偏好渠道管理，跨渠道分发）
  runtime.notificationRouter = createNotificationRouter(runtime);

  // 初始化结构化输出引擎（强制 LLM 返回合规 JSON，含重试和多数投票）
  // 使用延迟引用 runtime.llmComplete，允许在 structuredOutput 创建后才注入 LLM
  runtime.structuredOutput = createStructuredOutputEngine(async (opts) => {
    const fn = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
    if (!fn) {
      throw new Error("LLM 未配置：请设置 CLAWORKS_LLM_BASE_URL 或对接 OpenClaw 提供商");
    }
    return fn(opts);
  });

  // 注册 Pack factory 贡献（action handlers / intent mappings / capabilities）
  await applyPackContributions(runtime, packs);

  return runtime;
}

export async function startClaworksRuntime(runtime: ClaworksRuntime): Promise<void> {
  const slog = createRuntimeLogger(runtime.logger, "claworks:runtime");
  markRuntimeStarted();
  await runtime.kernel.start();
  slog.info("运行时内核已启动");
  const hydrated = await runtime.playbookEngine.hydrateSuspendedRuns();
  if (hydrated > 0) {
    slog.info(`hydrated ${hydrated} waiting_hitl run(s)`);
  }
  runtime.scheduler.reload(runtime.playbookEngine.list());

  // 从 ObjectStore 恢复动态添加的计划任务（schedule.add 持久化，重启后恢复）
  try {
    const storedTasks = await runtime.objectStore.query("ScheduledTask", { limit: 500 });
    for (const obj of storedTasks.items) {
      const task = obj.data as Record<string, unknown>;
      if (task.enabled === false) {
        continue;
      }
      const playbookId = String(task.playbook_id ?? task.id ?? "");
      const cron = String(task.cron ?? "");
      if (!playbookId || !cron) {
        continue;
      }
      const existing = runtime.playbookEngine.list().find((p) => p.id === playbookId);
      if (!existing) {
        continue;
      }
      const timezone = task.timezone ? String(task.timezone) : undefined;
      const dynDef = {
        id: playbookId,
        name: existing.name ?? playbookId,
        pack: existing.pack ?? "dynamic",
        priority: existing.priority ?? 50,
        trigger: { kind: "schedule" as const, cron, timezone },
        steps: existing.steps,
      };
      try {
        runtime.scheduler.add(dynDef);
        slog.info(`[schedule] 已恢复动态任务: ${playbookId} cron=${cron}`);
      } catch {
        slog.warn(`[schedule] 恢复任务失败（cron 无效）: ${playbookId}`);
      }
    }
  } catch {
    // ObjectStore 不可用时静默跳过，不阻断启动
  }

  // 启动时从 ObjectStore 同步 RBAC/Ingress 策略
  const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync.js");
  await syncRbacFromObjectStore(runtime);
  await syncIngressFromObjectStore(runtime);
  runtime.evolutionSync?.loadPendingPromotionsFromDb();
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
        slog.error(`[connector] auto_start ${id} failed`, err);
      }
    }
  }
  await runtime.kernel.flushOutbox();
  runtime._outboxFlushTimer = setInterval(() => {
    void runtime.kernel.flushOutbox().catch((err) => {
      slog.error("[outbox] flush failed", err);
    });
  }, 30_000);

  // HITL timeout sweep — auto-resolve expired approvals every 30 s
  runtime._hitlExpiryTimer = setInterval(() => {
    void runtime.playbookEngine
      .expireStaleHitl()
      .then((n) => {
        if (n > 0) {
          slog.info(`[hitl] expired ${n} stale HITL token(s)`);
        }
      })
      .catch((err) => {
        slog.error("[hitl] expiry sweep failed", err);
      });
  }, 30_000);

  // Startup configuration health validation
  const startupWarnings = validateStartupConfig(runtime.config);
  if (startupWarnings.length > 0) {
    startupWarnings.forEach((w) => slog.warn(`[startup] ${w}`));
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

  registerPackProfileEventHandler(runtime);

  const { wireEvolutionSimulationRegressionChain } =
    await import("../kernel/evolution-regression-chain.js");
  wireEvolutionSimulationRegressionChain(runtime);
  registerEvolutionAutoPromoteHandler(runtime);

  runtime.kernel.bus.subscribe("autonomy.learn_opportunity", async (event) => {
    try {
      const { handleAutonomyLearnOpportunity } = await import("../kernel/autonomy-engine.js");
      const result = await handleAutonomyLearnOpportunity(
        runtime,
        (event.payload ?? {}) as Record<string, unknown>,
      );
      runtime.logger?.(
        `[claworks:autonomy] learn_opportunity handled signal=${String((event.payload as Record<string, unknown>)?.signal ?? "?")} actions=${result.actions_taken.join(",")}`,
      );
    } catch (err) {
      runtime.logger?.(
        `[claworks:autonomy] learn_opportunity handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // 启动自主巡逻定时器（机器人主动感知业务状态的核心机制）
  // 周期：patrol_interval_ms（默认 5 分钟）
  // Playbooks 可通过 trigger.event = "robot.patrol" 订阅巡逻事件
  const patrolIntervalMs = runtime.config.robot?.patrol_interval_ms ?? 5 * 60 * 1000;
  if (patrolIntervalMs > 0) {
    const patrolTimer = setInterval(async () => {
      let pendingRuns = 0;
      try {
        const runs = await runtime.playbookEngine.listRuns({ limit: 100 });
        pendingRuns = runs.filter((r) => r.status === "running").length;
      } catch {
        // non-critical: patrol publishes even if run stats are unavailable
      }
      await runtime.kernel
        .publish(CW_EVENTS.ROBOT_PATROL, "runtime", {
          robot_id: runtime.robot.name,
          ts: new Date().toISOString(),
          pending_runs: pendingRuns,
          playbook_count: runtime.playbookEngine.list().length,
        })
        .catch((err) => {
          runtime.logger?.(
            `[claworks:patrol] 发布巡逻事件失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, patrolIntervalMs);
    // 注册到 runtime 停止时清理（通过 stop 事件）
    runtime.kernel.bus.subscribe(CW_EVENTS.SYSTEM_RUNTIME_STOPPED, async () => {
      clearInterval(patrolTimer);
    });
    runtime.logger?.(`[claworks:patrol] 自主巡逻已启动，间隔=${patrolIntervalMs}ms`);
  }

  // 启动 AutonomyEngine 周期性学习机会扫描（5 分钟间隔）
  const autonomyScanMs = 5 * 60 * 1000;
  runtime._autonomyScanTimer = setInterval(async () => {
    try {
      const { detectLearnOpportunities } = await import("../kernel/autonomy-engine.js");
      await detectLearnOpportunities(runtime);
    } catch (err) {
      runtime.logger?.(
        `[claworks:autonomy] 扫描失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, autonomyScanMs);
  runtime.logger?.("[claworks:autonomy] 自主学习机会扫描已启动（每5分钟）");
}

function validateStartupConfig(config: ClaworksRobotConfig): string[] {
  const warnings: string[] = [];
  const isProduction = isClaworksProductionMode(config);
  const tag = isProduction ? "[PRODUCTION]" : "[DEV]";

  if (!config.model_router?.chat && !config.model_router?.complete && !config.model_router?.fast) {
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
  if (runtime._autonomyScanTimer) {
    clearInterval(runtime._autonomyScanTimer);
    runtime._autonomyScanTimer = undefined;
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
