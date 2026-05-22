/**
 * AutonomyEngine — ClaWorks 机器人自主运行引擎
 *
 * 比喻：人体的「自主神经系统」
 *   - 心跳（定时 tick）→ 维持机器人存活
 *   - 新陈代谢（health + gc）→ 清理、修复、巡检
 *   - 感知整合（观察 EventBus 近期事件）→ 发现学习机会
 *   - 自主判断（识别能力空缺 / 接口未探明）→ 排队任务
 *   - 自我进化（发布 autonomy.* 事件）→ Playbook 响应
 *   - 环境扫描（每小时）→ 发现新环境变量/服务
 *   - 对等机器人发现（每 6 小时）→ 维护 Swarm 健康
 *
 * 设计原则（对齐 OpenClaw Gateway）：
 *   - 不包含业务逻辑，只发布观察事件
 *   - 所有响应由 EventKernel + Playbook 处理
 *   - 注册为一个能力（autonomy.*），可以被 Playbook 调用
 *
 * 事件清单（发布到 EventKernel）：
 *   autonomy.heartbeat              — 每次 tick 发布，标识机器人存活
 *   autonomy.health_degraded        — 健康状态不为 ok
 *   autonomy.gap_detected           — 发现能力空缺
 *   autonomy.interface_found        — 发现未探明的新接口
 *   autonomy.learn_opportunity      — 近期事件中发现学习点
 *   autonomy.idle                   — 无任务待处理（机器人可主动找事情做）
 *   environment.new_resource_detected — 发现新环境资源
 *   environment.scan_completed      — 环境扫描完成
 *   swarm.discovery_cycle           — 触发一次对等机器人发现周期
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type { CapabilityDescriptor } from "./capability-registry.js";
import { createEnvironmentScanner } from "./environment-scanner.js";

// ── 配置 ──────────────────────────────────────────────────────────────────

export type AutonomyConfig = {
  /** 心跳间隔（毫秒），默认 5 分钟 */
  heartbeatIntervalMs?: number;
  /** 每次 tick 最多观察多少条近期事件 */
  observationWindowSize?: number;
  /** 是否开启主动进化（探测未知接口） */
  enableEvolution?: boolean;
  /** 是否输出 tick 日志 */
  verbose?: boolean;
  /** 环境扫描间隔（毫秒），默认 1 小时。0=禁用 */
  environmentScanIntervalMs?: number;
  /** 对等机器人发现间隔（毫秒），默认 6 小时。0=禁用 */
  peerDiscoveryIntervalMs?: number;
};

const DEFAULTS: Required<AutonomyConfig> = {
  heartbeatIntervalMs: 5 * 60 * 1000,
  observationWindowSize: 50,
  enableEvolution: true,
  verbose: false,
  environmentScanIntervalMs: 60 * 60 * 1000, // 1 小时
  peerDiscoveryIntervalMs: 6 * 60 * 60 * 1000, // 6 小时
};

// ── 内部状态 ──────────────────────────────────────────────────────────────

type EvolutionRecord = {
  at: Date;
  kind: "gap_closed" | "new_connector" | "learn_applied" | "health_restored";
  detail: string;
};

type AutonomyState = {
  tickCount: number;
  lastTickAt: Date | null;
  gapHistory: Set<string>;
  /** capabilityId → 最后一次被调用时间（从 autonomy 视角观察到的） */
  capabilityUsage: Map<string, number>;
  knownConnectors: Set<string>;
  /** 进化历史记录（最近 100 条） */
  evolutionLog: EvolutionRecord[];
  /** 上次健康检查状态，用于检测状态恢复 */
  lastHealthStatus: string;
};

// ── 公共接口 ──────────────────────────────────────────────────────────────

export type AutonomyEngine = {
  start(): void;
  stop(): void;
  /** 手动触发一次 tick（测试 / 强制自检用） */
  tick(): Promise<void>;
  state(): Readonly<AutonomyState>;
  /** 记录一次进化事件（外部触发，如 Playbook 执行后的反馈） */
  recordEvolution(kind: EvolutionRecord["kind"], detail: string): void;
};

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createAutonomyEngine(
  runtime: ClaworksRuntime,
  config: AutonomyConfig = {},
): AutonomyEngine {
  const cfg = { ...DEFAULTS, ...config };
  let timer: ReturnType<typeof setInterval> | null = null;

  const MAX_EVOLUTION_LOG = 100;

  const state: AutonomyState = {
    tickCount: 0,
    lastTickAt: null,
    gapHistory: new Set(),
    capabilityUsage: new Map(),
    knownConnectors: new Set(),
    evolutionLog: [],
    lastHealthStatus: "ok",
  };

  // 环境扫描状态
  let lastEnvScanAt: Date | null = null;
  // 已知环境资源指纹（避免重复上报）
  const knownEnvResources = new Set<string>();

  // 对等机器人发现状态
  let lastPeerDiscoveryAt: Date | null = null;

  // 懒加载环境扫描器（避免启动时 import 影响速度）
  const envScanner = createEnvironmentScanner();

  function addEvolutionRecord(kind: EvolutionRecord["kind"], detail: string): void {
    state.evolutionLog.push({ at: new Date(), kind, detail });
    if (state.evolutionLog.length > MAX_EVOLUTION_LOG) {
      state.evolutionLog.splice(0, state.evolutionLog.length - MAX_EVOLUTION_LOG);
    }
  }

  // ── 内部发布助手 ─────────────────────────────────────────────────────────

  async function publish(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await runtime.kernel.publish(type, "autonomy-engine", {
        ...payload,
        tick: state.tickCount,
        robot: runtime.robot.name,
      });
    } catch (err) {
      runtime.logger?.(
        `[autonomy] publish ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 心跳（维持存活） ─────────────────────────────────────────────────────

  async function emitHeartbeat(): Promise<void> {
    const uptime = state.lastTickAt
      ? Math.round((Date.now() - state.lastTickAt.getTime()) / 1000)
      : 0;
    await publish("autonomy.heartbeat", {
      uptime_s: uptime,
      capability_count: runtime.capabilities.listAll().length,
      pack_count: runtime.loadedPacks.length,
    });
  }

  // ── 健康巡检（新陈代谢） ─────────────────────────────────────────────────

  async function runHealthCheck(): Promise<void> {
    try {
      const result = await runtime.capabilities
        .get("system.health")
        ?.handler(makeCtx("autonomy.health_check"), {});

      const currentStatus = String(result?.status ?? "ok");

      if (currentStatus !== "ok") {
        state.lastHealthStatus = currentStatus;
        await publish("autonomy.health_degraded", {
          status: currentStatus,
          checks: result?.checks ?? [],
          reason: "health check failed",
        });
        runtime.logger?.(`[autonomy] health degraded: ${currentStatus}`);
      } else if (state.lastHealthStatus !== "ok") {
        // 健康状态从降级恢复 → 记录进化
        addEvolutionRecord("health_restored", `health restored from ${state.lastHealthStatus}`);
        state.lastHealthStatus = "ok";
        await publish("autonomy.health_restored", {
          previous_status: state.lastHealthStatus,
          restored_at: new Date().toISOString(),
        });
        runtime.logger?.("[autonomy] health restored");
      }
    } catch (err) {
      await publish("autonomy.health_degraded", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 能力空缺检测（自我认知） ──────────────────────────────────────────────

  async function detectCapabilityGaps(): Promise<void> {
    // 从近期事件中找"unknown capability"或"stub"响应
    try {
      const events = await runtime.kernel.bus.query({
        type: "message.handle",
        from: new Date(Date.now() - cfg.heartbeatIntervalMs * 3),
        limit: cfg.observationWindowSize,
      });

      const unknowns = events
        .map((e) => String(e.payload.original_capability ?? e.payload.requested_capability ?? ""))
        .filter((cap) => cap && !state.gapHistory.has(cap) && !runtime.capabilities.get(cap));

      for (const gap of unknowns) {
        state.gapHistory.add(gap);
        await publish("autonomy.gap_detected", {
          capability_id: gap,
          suggestion: `Consider registering a pack that provides '${gap}'`,
        });
        runtime.logger?.(`[autonomy] gap detected: ${gap}`);
      }

      // 检查之前记录的 gap 是否已被填补（新 Pack 安装后）
      for (const gap of state.gapHistory) {
        if (runtime.capabilities.get(gap)) {
          state.gapHistory.delete(gap);
          addEvolutionRecord("gap_closed", `capability gap closed: ${gap}`);
          await publish("autonomy.gap_closed", {
            capability_id: gap,
            closed_at: new Date().toISOString(),
          });
          runtime.logger?.(`[autonomy] gap closed: ${gap}`);
        }
      }
    } catch {
      // event query can fail if bus not yet started; silently ignore
    }
  }

  // ── 接口探测（主动发现未知接口） ─────────────────────────────────────────

  async function discoverInterfaces(): Promise<void> {
    if (!cfg.enableEvolution) {
      return;
    }

    const connectorIds = Object.keys(runtime.config.connectors ?? {});
    for (const id of connectorIds) {
      if (!state.knownConnectors.has(id)) {
        state.knownConnectors.add(id);
        addEvolutionRecord("new_connector", `discovered connector: ${id}`);
        await publish("autonomy.interface_found", {
          connector_id: id,
          status: runtime.connectorManager.status().find((s) => s.id === id)?.ready
            ? "running"
            : "stopped",
          action: "probe_pending",
        });
        runtime.logger?.(`[autonomy] new interface found: ${id}`);
      }
    }
  }

  // ── 学习机会识别（近期事件分析） ─────────────────────────────────────────

  async function detectLearnOpportunities(): Promise<void> {
    try {
      const recentEvents = await runtime.kernel.bus.query({
        from: new Date(Date.now() - cfg.heartbeatIntervalMs * 2),
        limit: cfg.observationWindowSize,
      });

      // 统计高频事件类型 → 可能值得学习
      const typeCounts = new Map<string, number>();
      for (const ev of recentEvents) {
        typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
      }

      const topTypes = [...typeCounts.entries()]
        .filter(([t]) => !t.startsWith("autonomy.") && !t.startsWith("system."))
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3);

      if (topTypes.length > 0) {
        addEvolutionRecord(
          "learn_applied",
          `high-frequency event types: ${topTypes.map(([t]) => t).join(", ")}`,
        );
        await publish("autonomy.learn_opportunity", {
          top_event_types: topTypes.map(([type, count]) => ({ type, count })),
          suggestion: "Review playbooks handling these event types",
          evolution_log_size: state.evolutionLog.length,
        });
      }

      // 识别空闲：近期几乎没有任何事件
      if (recentEvents.length < 3) {
        await publish("autonomy.idle", {
          since_ms: cfg.heartbeatIntervalMs * 2,
          suggestion: "Consider probing connected interfaces or reviewing knowledge base",
        });
      }
    } catch {
      // silently ignore
    }
  }

  // ── ctx 工厂 ──────────────────────────────────────────────────────────────

  function makeCtx(source: string) {
    return {
      source,
      subjectId: runtime.robot.name,
      subjectType: "system",
      invoke: async (capId: string, params: Record<string, unknown>) => {
        const d = runtime.capabilities.get(capId);
        if (!d) {
          throw new Error(`unknown capability: ${capId}`);
        }
        return d.handler(makeCtx(source), params);
      },
      logger: runtime.logger,
    };
  }

  // ── 环境扫描（主动感知新资源） ───────────────────────────────────────────

  async function runEnvironmentScan(): Promise<void> {
    if (cfg.environmentScanIntervalMs === 0) {
      return;
    }

    const now = new Date();
    if (lastEnvScanAt && now.getTime() - lastEnvScanAt.getTime() < cfg.environmentScanIntervalMs) {
      return;
    }

    try {
      lastEnvScanAt = now;
      const result = await envScanner.scan({
        environment: true,
        fileSystem: {
          paths: [process.cwd()],
          maxDepth: 2,
        },
        knownServices: false, // 避免频繁探测端口
      });

      const newResources: Array<{
        resource_type: string;
        resource_name: string;
        resource_id: string;
      }> = [];

      // 检查新发现的环境变量资源
      for (const envVar of result.envVars) {
        const fingerprint = `env:${envVar.key}:${envVar.type}`;
        if (!knownEnvResources.has(fingerprint)) {
          knownEnvResources.add(fingerprint);
          newResources.push({
            resource_type: envVar.type,
            resource_name: envVar.key,
            resource_id: fingerprint,
          });
        }
      }

      // 检查新发现的文件资源
      for (const resource of result.resources) {
        if (!knownEnvResources.has(resource.id)) {
          knownEnvResources.add(resource.id);
          newResources.push({
            resource_type: resource.type,
            resource_name: resource.name,
            resource_id: resource.id,
          });
        }
      }

      if (newResources.length > 0) {
        for (const r of newResources) {
          await publish("environment.new_resource_detected", r);
          if (cfg.verbose) {
            runtime.logger?.(`[autonomy] 新环境资源：${r.resource_type}/${r.resource_name}`);
          }
        }
        addEvolutionRecord(
          "new_connector",
          `environment scan: ${newResources.length} new resources`,
        );
      }

      await publish("environment.scan_completed", {
        resources_found: result.resources.length,
        env_vars_found: result.envVars.length,
        new_resources: newResources.length,
        duration_ms: result.durationMs,
      });
    } catch (err) {
      runtime.logger?.(
        `[autonomy] environment scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 对等机器人发现（协作感知） ───────────────────────────────────────────

  async function runPeerDiscovery(): Promise<void> {
    if (cfg.peerDiscoveryIntervalMs === 0) {
      return;
    }
    if (!runtime.config.a2a?.enabled) {
      return;
    }
    if (!runtime.config.a2a?.peers?.length) {
      return;
    }

    const now = new Date();
    if (
      lastPeerDiscoveryAt &&
      now.getTime() - lastPeerDiscoveryAt.getTime() < cfg.peerDiscoveryIntervalMs
    ) {
      return;
    }

    try {
      lastPeerDiscoveryAt = now;
      await publish("swarm.discovery_cycle", {
        peers_configured: runtime.config.a2a.peers?.length ?? 0,
        triggered_by: "autonomy-engine",
      });
      runtime.logger?.("[autonomy] 触发 Swarm 对等机器人发现周期");
    } catch {
      // silently ignore
    }
  }

  // ── 主 tick ───────────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    state.tickCount += 1;
    state.lastTickAt = new Date();

    if (cfg.verbose) {
      runtime.logger?.(`[autonomy] tick #${state.tickCount}`);
    }

    await emitHeartbeat();
    await runHealthCheck();
    await discoverInterfaces();
    await runEnvironmentScan();
    await runPeerDiscovery();

    // 每 3 次 tick 做一次深度分析（避免高频噪声）
    if (state.tickCount % 3 === 0) {
      await detectCapabilityGaps();
      await detectLearnOpportunities();
    }

    // 每 6 次 tick（约 30 分钟）做一次业务主动检查
    if (state.tickCount % 6 === 0) {
      await runProactiveChecks();
    }
  }

  // ── 业务主动性检查（主动发现需要关注的业务状态） ────────────────────────────

  async function runProactiveChecks(): Promise<void> {
    try {
      // 检查超过 30 分钟未处理的报警
      await publish("autonomy.proactive_check", {
        check_type: "stale_alarms",
        threshold_minutes: 30,
      });

      // 检查待处理的 HITL 审批（超过 60 分钟未处理）
      await publish("autonomy.proactive_check", {
        check_type: "pending_hitl",
        threshold_minutes: 60,
      });

      if (cfg.verbose) {
        runtime.logger?.("[autonomy] proactive checks dispatched");
      }
    } catch {
      // silently ignore
    }
  }

  let firstDelayTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    start() {
      if (timer || firstDelayTimer) {
        return;
      }
      // 启动后 30 秒做第一次 tick，给 runtime 时间完成初始化
      firstDelayTimer = setTimeout(() => {
        firstDelayTimer = null;
        void tick();
        timer = setInterval(() => void tick(), cfg.heartbeatIntervalMs);
      }, 30_000);

      runtime.logger?.(`[autonomy] started (interval=${cfg.heartbeatIntervalMs / 1000}s)`);
    },

    stop() {
      if (firstDelayTimer) {
        clearTimeout(firstDelayTimer);
        firstDelayTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
        runtime.logger?.("[autonomy] stopped");
      }
    },

    tick,

    state() {
      return {
        ...state,
        gapHistory: new Set(state.gapHistory),
        capabilityUsage: new Map(state.capabilityUsage),
        knownConnectors: new Set(state.knownConnectors),
        evolutionLog: [...state.evolutionLog],
      };
    },

    recordEvolution(kind: EvolutionRecord["kind"], detail: string): void {
      addEvolutionRecord(kind, detail);
    },
  };
}

// ── 能力描述符（注册为 autonomy.* 能力） ────────────────────────────────────

export function makeAutonomyCapabilities(
  engine: AutonomyEngine,
  runtime: ClaworksRuntime,
): CapabilityDescriptor[] {
  const makeCtx = (source: string) => ({
    source,
    subjectId: runtime.robot.name,
    subjectType: "system",
    invoke: async (capId: string, params: Record<string, unknown>) => {
      const d = runtime.capabilities.get(capId);
      if (!d) {
        throw new Error(`unknown capability: ${capId}`);
      }
      return d.handler(makeCtx(source), params);
    },
    logger: runtime.logger,
  });

  return [
    {
      id: "autonomy.tick",
      verb: "control",
      description: "手动触发一次自主 tick（巡检 + 学习检测）",
      owner: { kind: "core" },
      handler: async () => {
        await engine.tick();
        return { status: "ok", tick: engine.state().tickCount };
      },
    },
    {
      id: "autonomy.state",
      verb: "query",
      description: "返回自主引擎当前状态（含进化历史）",
      owner: { kind: "core" },
      handler: async () => {
        const s = engine.state();
        return {
          tick_count: s.tickCount,
          last_tick_at: s.lastTickAt?.toISOString() ?? null,
          gap_count: s.gapHistory.size,
          known_connectors: [...s.knownConnectors],
          evolution_log: s.evolutionLog.slice(-20).map((e) => ({
            at: e.at.toISOString(),
            kind: e.kind,
            detail: e.detail,
          })),
          evolution_count: s.evolutionLog.length,
          health_status: s.lastHealthStatus,
        };
      },
    },
    {
      id: "autonomy.probe_interface",
      verb: "acquire",
      description: "探测一个 connector 并获取其方法目录",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["connector_id"],
        properties: { connector_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const connectorId = String(params.connector_id ?? "");
        const statusEntry = runtime.connectorManager.status().find((s) => s.id === connectorId);
        if (!statusEntry?.ready) {
          return { status: "not_running", connector_id: connectorId };
        }
        try {
          // 大多数 connector 实现了 "describe" 方法，返回可用 API 列表
          const result = await runtime.connectorManager.invoke(connectorId, "describe", {});
          return {
            status: "ok",
            connector_id: connectorId,
            ...(result as Record<string, unknown>),
          };
        } catch {
          return {
            status: "no_describe",
            connector_id: connectorId,
            note: "Connector does not implement describe(). Try probing with known methods.",
          };
        }
      },
    },
  ];
}
