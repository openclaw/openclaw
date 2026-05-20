import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectorManager } from "../interfaces/connectors/connector-manager.js";
import { resolveConnectorConfigs } from "../interfaces/connectors/presets.js";
import { createEventKernel, type EventKernel } from "../kernel/event-kernel.js";
import { createIngressRouter, DEFAULT_INGRESS_POLICIES } from "../kernel/ingress.js";
import { createPlaybookScheduler } from "../kernel/scheduler.js";
import type { KnowledgeBase, RobotInfo } from "../kernel/types.js";
import { createPackLoader } from "../pack-loader/index.js";
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
  SubagentRunFn,
} from "../planes/orch/step-executor.js";
import type { A2aPeerConfig } from "./a2a-peers.js";
import { applyIngressPublish } from "./ingress-publish.js";
import { createModelRouter } from "./model-router.js";
import { appendObservationEvent, markRuntimeStarted } from "./observability.js";
import {
  loadPersistedInstalled,
  mergePackConfig,
  reloadClaworksPackById,
  reloadClaworksPacksFromDisk,
} from "./pack-runtime.js";
import { schedulePolicySync } from "./policy-sync.js";
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
  const dbUrl = config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`;
  const { db, close, dialect, note } = openDatabase(dbUrl);
  if (note) {
    opts?.logger?.(`[claworks] ${note}`);
  }
  void dialect;

  const robot: RobotInfo = {
    name: config.robot?.name ?? "claworks-robot",
    role: config.robot?.role ?? "monolith",
    version: opts?.version ?? "2026.5.0-alpha.1",
    endpoint: `http://${config.robot?.host ?? "127.0.0.1"}:${config.robot?.port ?? 8000}`,
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
    logger: opts?.logger,
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
      installed: config.packs?.installed ?? ["base", "process-industry"],
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
    loadedPacks: packs,
    packLoader,
    connectorManager,
    scheduler,
    logger: opts?.logger,
    close,
  };
  policySyncTarget.runtime = runtime;

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

  await runtime.kernel.publish("system.runtime.started", "runtime", {
    version: runtime.robot.version,
    name: runtime.robot.name,
    role: runtime.robot.role,
    packCount: runtime.loadedPacks.length,
    playbookCount: runtime.playbookEngine.list().length,
    endpoint: runtime.robot.endpoint,
  });
}

export async function stopClaworksRuntime(runtime: ClaworksRuntime): Promise<void> {
  if (runtime._outboxFlushTimer) {
    clearInterval(runtime._outboxFlushTimer);
    runtime._outboxFlushTimer = undefined;
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
