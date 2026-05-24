/**
 * core-capabilities.ts — ClaWorks 机器人核心能力注册
 *
 * 分层（类比人的基础能力）：
 *
 *   L0  system.*     生命维持（心跳、自描述、健康）
 *   L1  environment.*  感知环境（时间、上下文、主体画像）
 *   L2  kb.*         记忆（学习、检索、遗忘）
 *   L3  perceive.*   感知（理解消息、提取意图、解析实体）
 *   L4  task.*       执行（运行任务、查询状态）
 *   L5  object.*     操作（实体 CRUD）
 *   L6  event.*      信号（发布事件）
 *   L7  learn.*      主动学习（从观察中学习、调度学习任务）
 *   L8  evolve.*     自我进化（发现接口、生成 Playbook、拓展能力）
 *   L9  message.*    通用消息处理（兜底）
 */

import { readFile } from "node:fs/promises";
import { createAutoConnectManager } from "../claworks/auto-connect.js";
import { createHarnessSync } from "../claworks/harness-sync.js";
import { buildHealthPayload } from "../claworks/health.js";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type {
  FieldDefinition,
  FsmDefinition,
  ObjectTypeDefinition,
} from "../planes/data/ontology-types.js";
import { BRIDGE_LLM } from "./bridge-registry.js";
import {
  createCapabilityRegistry,
  type CapabilityDescriptor,
  type CapabilityRegistry,
} from "./capability-registry.js";
import { createEnvironmentScanner } from "./environment-scanner.js";
import { createEvolveEngine, type EvolveProposal, type EvolveResult } from "./evolve-engine.js";
import { createRobotSwarm, makeSwarmCapabilities } from "./robot-swarm.js";
import type { DecisionTable } from "./rule-engine.js";
import { SystemPromptBuilder } from "./system-prompt-builder.js";

// ── system.* ─────────────────────────────────────────────────────────────

function makeSystemHealthDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.health",
    verb: "query",
    description: "返回机器人健康状态与诊断报告",
    owner: { kind: "core" },
    handler: async () => buildHealthPayload(runtime) as unknown as Record<string, unknown>,
  };
}

function makeSystemStatusDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.status",
    verb: "query",
    description: "返回机器人基础信息与运行时状态",
    owner: { kind: "core" },
    handler: async () => ({
      robot: runtime.robot.name,
      role: runtime.robot.role,
      version: runtime.robot.version,
      endpoint: runtime.robot.endpoint,
      packs: runtime.loadedPacks.map((p) => p.manifest.id),
      dialect: runtime.databaseDialect,
    }),
  };
}

function makeSystemDescribeDescriptor(registry: CapabilityRegistry): CapabilityDescriptor {
  return {
    id: "system.describe",
    verb: "query",
    description: "列出机器人所有已注册能力（自我介绍）",
    owner: { kind: "core" },
    handler: async () => ({
      capabilities: registry.list(),
    }),
  };
}

function makeSystemVersionDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.version",
    verb: "query",
    description: "返回机器人版本信息（版本号、构建时间、运行时环境）",
    owner: { kind: "core" },
    handler: async () => ({
      version: runtime.robot.version,
      name: runtime.robot.name,
      role: runtime.robot.role,
      node_version: process.version,
      platform: process.platform,
      uptime_seconds: Math.floor(process.uptime()),
    }),
  };
}

function makeSystemStatsDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.stats",
    verb: "query",
    description: "返回运行时统计数据（Playbook 执行数、事件发布量、能力数量）",
    owner: { kind: "core" },
    handler: async () => {
      const capabilities = runtime.capabilities.list();
      const packs = runtime.loadedPacks;
      const playbooks = runtime.playbookEngine.list();
      return {
        capabilities_count: capabilities.length,
        packs_count: packs.length,
        playbooks_count: playbooks.length,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };
    },
  };
}

function makeSystemPackListDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.pack_list",
    verb: "query",
    description: "返回已加载的 Pack 列表（id、版本、playbooks 数量）",
    owner: { kind: "core" },
    handler: async () => ({
      packs: runtime.loadedPacks.map((p) => ({
        id: p.manifest.id,
        name: (p.manifest as { name?: string }).name ?? p.manifest.id,
        version: (p.manifest as { version?: string }).version ?? "unknown",
        playbooks: p.playbooks.length,
        object_types: p.objectTypes.length,
        path: p.path,
      })),
      count: runtime.loadedPacks.length,
    }),
  };
}

/** system.learn：探测一个外部接口并将其 schema 注册为新能力 */
function makeSystemLearnDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "system.learn",
    verb: "acquire",
    description: "探测接口 schema，自动生成 Playbook 或注册新能力",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        connector_id: { type: "string", description: "连接器 ID" },
        interface_url: { type: "string", description: "OpenAPI/MCP URL" },
      },
    },
    handler: async (_ctx, params) => {
      const connectorId = String(params.connector_id ?? "");
      const interfaceUrl = String(params.interface_url ?? "");
      // 当前: 记录意图到 KB，触发 learn.interface 事件，后续由 Playbook 处理
      if (connectorId || interfaceUrl) {
        await runtime.kernel.publish("learn.interface.requested", "system.learn", {
          connector_id: connectorId,
          interface_url: interfaceUrl,
        });
      }
      return { status: "queued", connector_id: connectorId, interface_url: interfaceUrl };
    },
  };
}

// ── kb.* ─────────────────────────────────────────────────────────────────

function makeKbSearchDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  // 30 秒 TTL、50 条容量的查询缓存，减少高频重复检索对 KB 的压力。
  // 写入路径 TTL 自然过期即可；semantic 搜索结果同样缓存（key 含 semantic 标志）。
  const kbSearchCache = new Map<string, { result: Record<string, unknown>; expiresAt: number }>();
  const KB_SEARCH_CACHE_TTL_MS = 30_000;
  const KB_SEARCH_CACHE_MAX = 50;

  return {
    id: "kb.search",
    verb: "retrieve",
    description: "在知识库中检索（支持 semantic=true 语义搜索，无 embedding 时自动降级 BM25）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        top_k: { type: "integer", default: 5 },
        min_score: { type: "number" },
        semantic: {
          type: "boolean",
          default: false,
          description: "true = 语义向量搜索（无 embedding 时降级 BM25）",
        },
        namespace: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const query = String(params.query ?? "");
      const topK = typeof params.top_k === "number" ? params.top_k : 5;
      const namespace = typeof params.namespace === "string" ? params.namespace : undefined;
      const semantic = params.semantic === true;

      const cacheKey = `${query}:${topK}:${namespace ?? ""}:${semantic}`;
      const cached = kbSearchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      let results;
      if (semantic && runtime.kb.semanticSearch) {
        results = await runtime.kb.semanticSearch(query, { limit: topK, namespace });
      } else {
        results = await runtime.kb.search(query, { limit: topK, namespace });
      }
      const kbAny = runtime.kb as unknown as Record<string, unknown>;
      const embeddingAvailable =
        typeof kbAny.semanticSearch === "function" && typeof kbAny.supportsEmbedding === "boolean"
          ? kbAny.supportsEmbedding
          : typeof kbAny.semanticSearch === "function";
      const result = {
        results,
        count: results.length,
        provider: (kbAny.provider as string | undefined) ?? "unknown",
        semantic_used: semantic,
        embedding_available: embeddingAvailable,
      };

      if (kbSearchCache.size >= KB_SEARCH_CACHE_MAX) {
        const firstKey = kbSearchCache.keys().next().value;
        if (firstKey !== undefined) kbSearchCache.delete(firstKey);
      }
      kbSearchCache.set(cacheKey, { result, expiresAt: Date.now() + KB_SEARCH_CACHE_TTL_MS });

      return result;
    },
  };
}

function makeKbIngestDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "kb.ingest",
    verb: "acquire",
    description: "将文本内容写入知识库",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (_ctx, params) => {
      await runtime.kb.ingest(String(params.content ?? ""), {
        source: typeof params.source === "string" ? params.source : undefined,
        namespace: typeof params.namespace === "string" ? params.namespace : undefined,
      });
      return { status: "ok" };
    },
  };
}

function makeKbStatusDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "kb.status",
    verb: "query",
    description: "返回知识库统计与健康状态",
    owner: { kind: "core" },
    handler: async () => {
      const count = (await runtime.kb.count?.()) ?? -1;
      return { provider: runtime.config.data?.kb_provider ?? "stub", doc_count: count };
    },
  };
}

// ── task.* ────────────────────────────────────────────────────────────────

function makeTaskRunDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "task.run",
    verb: "compose",
    description: "按名称触发一个 Playbook 任务",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["playbook_id"],
      properties: {
        playbook_id: { type: "string" },
        input: { type: "object" },
      },
    },
    handler: async (ctx, params) => {
      const id = String(params.playbook_id ?? "");
      const input = (params.input as Record<string, unknown> | undefined) ?? {};
      const run = await runtime.playbookEngine.trigger(id, {
        ...input,
        _source: ctx.source,
        _correlationId: ctx.correlationId,
      });

      // 改进3：Playbook 成功完成后非阻塞地写入 CBR，闭合学习循环
      if (run.status === "completed" && runtime.cbrStore) {
        const inputText = typeof input.text === "string" ? input.text : id;
        const intentHint = typeof input.intent === "string" ? input.intent : id;
        try {
          runtime.cbrStore.add(inputText, intentHint, {
            outcome: "success",
            playbookId: id,
            runId: run.id,
            confidence: 0.8,
          });
        } catch {
          // 非关键路径，忽略写入失败
        }
      }

      return { run_id: run.id, status: run.status };
    },
  };
}

function makeTaskStatusDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "task.status",
    verb: "query",
    description: "查询 Playbook 运行状态",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
    handler: async (_ctx, params) => {
      const run = await runtime.playbookEngine.getRun(String(params.run_id ?? ""));
      if (!run) {
        return { status: "not_found" };
      }
      return { run_id: run.id, status: run.status, error: run.error ?? null };
    },
  };
}

// ── object.* ─────────────────────────────────────────────────────────────

function makeObjectCreateDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "object.create",
    verb: "transform",
    description: "在对象存储中创建实体",
    owner: { kind: "core" },
    rbac: { decision: "hitl_required", reason: "创建实体需要人工确认" },
    handler: async (ctx, params) => {
      const typeName = String(params.type ?? params.object_type ?? "");
      const { type: _t, object_type: _ot, ...fields } = params;
      const created = await runtime.objectStore.create(
        typeName,
        fields,
        ctx.stepCtx ?? ({} as never),
      );
      return { status: "ok", ...created };
    },
  };
}

function makeObjectQueryDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "object.query",
    verb: "retrieve",
    description: "查询对象存储中的实体列表",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string" },
        filter: { type: "object" },
        limit: { type: "integer" },
      },
    },
    handler: async (_ctx, params) => {
      const typeName = String(params.type ?? "");
      const filter = (params.filter as Record<string, unknown> | undefined) ?? {};
      const limit = typeof params.limit === "number" ? params.limit : 20;
      const { items } = await runtime.objectStore.query(typeName, { filter, limit });
      return { results: items, count: items.length };
    },
  };
}

function makeObjectUpdateDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "object.update",
    verb: "transform",
    description: "更新对象存储中的实体字段",
    owner: { kind: "core" },
    rbac: { decision: "hitl_required", reason: "修改实体需要人工确认" },
    handler: async (_ctx, params) => {
      const typeName = String(params.type ?? params.object_type ?? "");
      const id = String(params.id ?? params.object_id ?? "");
      const { type: _t, object_type: _ot, id: _id, object_id: _oid, ...fields } = params;
      const updated = await runtime.objectStore.update(typeName, id, fields);
      return { status: "ok", ...updated };
    },
  };
}

function makeObjectListTypesDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "object.list_types",
    verb: "query",
    description: "列出 Ontology 引擎中所有已注册的对象类型（ObjectType）",
    owner: { kind: "core" },
    handler: async () => {
      const types = runtime.ontology.listTypes();
      return { types: types.map((t) => ({ name: t.name, pack: t.pack })), count: types.length };
    },
  };
}

// ── event.* ───────────────────────────────────────────────────────────────

function makeEventPublishDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "event.publish",
    verb: "deliver",
    description: "向 EventKernel 发布事件",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string" },
        payload: { type: "object" },
        correlation_id: { type: "string" },
      },
    },
    handler: async (ctx, params) => {
      const eventType = String(params.type ?? "");
      const payload = (params.payload as Record<string, unknown> | undefined) ?? {};
      const correlationId = String(params.correlation_id ?? ctx.correlationId ?? "");
      await runtime.kernel.publish(eventType, ctx.source, payload, { correlationId });
      return { status: "ok", event_type: eventType };
    },
  };
}

// ── message.handle (兜底) ─────────────────────────────────────────────────

function makeMessageHandleDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "message.handle",
    verb: "compose",
    description: "兜底处理：对任何未知消息用 LLM 回答，或告知不会",
    advertise: false,
    owner: { kind: "core" },
    handler: async (ctx, params) => {
      const text = String(params.text ?? params.message ?? params.content ?? "");
      const sessionId = String(params.session_id ?? ctx.source ?? "");
      const modeOnly = params.mode === "format_only";

      // 记录用户消息到对话上下文
      if (sessionId && text && !modeOnly) {
        runtime.contextEngine?.append(sessionId, "user", text);
      }

      const llm = (
        runtime as unknown as { bridges?: { get?: (k: string) => unknown } }
      ).bridges?.get?.(BRIDGE_LLM) as
        | { complete?: (p: { prompt: string }) => Promise<{ text: string }> }
        | undefined;

      if (modeOnly) {
        // format_only 模式：直接返回格式化文本，不调用 LLM
        return { status: "ok", reply: text, mode: "format_only" };
      }

      if (!llm?.complete && !runtime.llmComplete) {
        return {
          status: "fallback",
          reply:
            "收到你的消息，但我现在还不知道该怎么处理它。请尝试更具体的指令，或者告诉我你想做什么。",
          original: text,
        };
      }

      // 从 KB 检索相关上下文
      let kbContext = "";
      try {
        const kbResults = await runtime.kb.search(text, { limit: 3 });
        if (kbResults.length > 0) {
          kbContext =
            "\n\n相关知识库内容：\n" +
            kbResults.map((r) => String(r.content ?? r.title ?? "")).join("\n---\n");
        }
      } catch {
        // KB 检索失败不影响主流程
      }

      // 获取对话历史上下文
      let contextHistory = "";
      if (sessionId && runtime.contextEngine) {
        const recentTurns = runtime.contextEngine.getRecent(sessionId, 6);
        if (recentTurns.length > 1) {
          contextHistory =
            "\n\n对话历史：\n" +
            recentTurns
              .slice(0, -1)
              .map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.content}`)
              .join("\n");
        }
      }

      const capabilities =
        runtime.capabilities
          ?.list()
          .map((c) => `${c.id}: ${c.description}`)
          .join("\n") ?? "";
      const prompt = [
        "你是 ClaWorks 机器人助手，以下是你当前具备的能力列表：",
        capabilities,
        contextHistory,
        kbContext,
        "",
        "用户发来的消息：",
        text,
        "",
        "请直接回答。如果超出你的能力范围，诚实说明，并告诉用户你能做什么。",
      ]
        .filter(Boolean)
        .join("\n");

      const completeFn = llm?.complete ?? runtime.llmComplete;
      if (!completeFn) {
        return { status: "fallback", reply: "暂时无法处理该消息，LLM 未配置。" };
      }
      const result = await completeFn({ prompt });

      // 记录机器人回复到对话上下文
      if (sessionId && runtime.contextEngine) {
        runtime.contextEngine.append(sessionId, "assistant", result.text);
      }

      return { status: "ok", reply: result.text };
    },
  };
}

// ── environment.* (感知环境) ───────────────────────────────────────────────

function makeEnvironmentContextDescriptor(): CapabilityDescriptor {
  return {
    id: "environment.context",
    verb: "query",
    description: "返回当前时间、日历、地区等环境上下文，帮助机器人理解「现在是什么情况」",
    owner: { kind: "core" },
    handler: async () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const locale = process.env.LANG ?? process.env.LC_ALL ?? "zh-CN";
      const weekday = now.toLocaleDateString("zh-CN", { weekday: "long" });
      const hour = now.getHours();
      const period =
        hour < 6
          ? "深夜"
          : hour < 12
            ? "上午"
            : hour < 14
              ? "中午"
              : hour < 18
                ? "下午"
                : hour < 22
                  ? "晚上"
                  : "深夜";

      // 简单节假日感知（基于月日）
      const upcomingHolidays: string[] = [];
      const HOLIDAYS: Array<[number, number, string]> = [
        [1, 1, "元旦"],
        [2, 14, "情人节"],
        [5, 1, "劳动节"],
        [6, 1, "儿童节"],
        [10, 1, "国庆节"],
        [12, 25, "圣诞节"],
      ];
      for (const [hm, hd, name] of HOLIDAYS) {
        const daysDiff = new Date(now.getFullYear(), hm - 1, hd).getTime() - now.getTime();
        const days = Math.ceil(daysDiff / 86_400_000);
        if (days >= 0 && days <= 7) {
          upcomingHolidays.push(`${name}（${days === 0 ? "今天" : `${days}天后`}）`);
        }
      }

      return {
        now: now.toISOString(),
        timezone: tz,
        locale,
        weekday,
        period,
        hour,
        upcoming_holidays: upcomingHolidays,
        work_day: now.getDay() >= 1 && now.getDay() <= 5,
      };
    },
  };
}

function makeEnvironmentProfileDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "environment.profile",
    verb: "query",
    description: "返回当前部署环境画像（机器人角色、已连接接口、所在行业等）",
    owner: { kind: "core" },
    handler: async () => {
      const connectorIds = Object.keys(runtime.config.connectors ?? {});
      const channels = runtime.loadedPacks.flatMap((p) =>
        (p.manifest.provides.playbooks ?? []).filter((id: string) => id.includes("channel")),
      );
      return {
        robot_name: runtime.robot.name,
        robot_role: runtime.robot.role,
        packs: runtime.loadedPacks.map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
        })),
        connected_interfaces: connectorIds,
        channels,
        capabilities_count: runtime.capabilities.listAll().length,
        industry_hint: runtime.config.robot?.role ?? "general",
      };
    },
  };
}

// ── environment.scan / harness.* / connect.* (新感知维度) ────────────────

function makeEnvironmentScanDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const scanner = createEnvironmentScanner();
  return {
    id: "environment.scan",
    verb: "acquire",
    description: "扫描当前环境（环境变量、文件系统、常见网络服务）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        environment: { type: "boolean", default: true },
        file_system: { type: "boolean", default: true },
        known_services: { type: "boolean", default: false },
      },
    },
    handler: async (_ctx, params) => {
      const result = await scanner.scan({
        environment: params.environment !== false,
        fileSystem:
          params.file_system !== false ? { paths: [process.cwd()], maxDepth: 2 } : undefined,
        knownServices: params.known_services === true,
      });
      await runtime.kernel.publish("environment.scan_completed", "environment.scan", {
        resources_found: result.resources.length,
        env_vars_found: result.envVars.length,
        openclaw_found: result.openClaw.found,
        duration_ms: result.durationMs,
      });
      return {
        resources: result.resources.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          location: r.location,
          status: r.status,
          auto_connectable: r.autoConnectable,
          suggested_connector: r.suggestedConnector,
        })),
        env_vars: result.envVars,
        openclaw: result.openClaw,
        count: result.resources.length + result.envVars.length,
        duration_ms: result.durationMs,
      };
    },
  };
}

function makeEnvironmentScanEnvvarsDescriptor(): CapabilityDescriptor {
  const scanner = createEnvironmentScanner();
  return {
    id: "environment.scan_envvars",
    verb: "acquire",
    description: "扫描环境变量，发现 IM Token、API Key、数据库 URL 等潜在服务连接",
    owner: { kind: "core" },
    handler: async () => {
      const hints = await scanner.scanEnvVars();
      return { hints, count: hints.length };
    },
  };
}

function makeEnvironmentDetectServicesDescriptor(): CapabilityDescriptor {
  const scanner = createEnvironmentScanner();
  return {
    id: "environment.detect_services",
    verb: "acquire",
    description: "检测本地常见服务（飞书/MySQL/Redis/MQTT/OPC-UA 等）是否可达",
    owner: { kind: "core" },
    handler: async () => {
      const result = await scanner.scan({ knownServices: true, environment: false });
      const available = result.resources.map((r) => r.name);
      return { services: result.resources, available, count: result.resources.length };
    },
  };
}

function makeHarnessDetectDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const hs = createHarnessSync(runtime);
  return {
    id: "harness.detect_openclaw",
    verb: "query",
    description: "检测本机 OpenClaw 安装（~/.openclaw/agents/...）",
    owner: { kind: "core" },
    handler: async () => hs.detectOpenClaw(),
  };
}

function makeHarnessSyncFromDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const hs = createHarnessSync(runtime);
  return {
    id: "harness.sync_from_openclaw",
    verb: "acquire",
    description: "从 OpenClaw 同步模型配置、技能和渠道信息到 ClaWorks",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        config_path: { type: "string", description: "OpenClaw 配置目录路径" },
      },
    },
    handler: async (_ctx, params) => {
      const detection = await hs.detectOpenClaw();
      const configPath = String(params.config_path ?? detection.configPath ?? "");
      if (!configPath) {
        return { synced: false, error: "未找到 OpenClaw 配置路径" };
      }
      return hs.syncFromOpenClaw(configPath);
    },
  };
}

function makeHarnessPushToDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const hs = createHarnessSync(runtime);
  return {
    id: "harness.push_to_openclaw",
    verb: "control",
    description: "向 OpenClaw Agent 注册 ClaWorks cw_* 工具",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "OpenClaw Agent ID（可选）" },
      },
    },
    handler: async (_ctx, params) => {
      return hs.pushToOpenClaw({ agentId: params.agent_id as string | undefined });
    },
  };
}

function makeHarnessStatusDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const hs = createHarnessSync(runtime);
  return {
    id: "harness.status",
    verb: "query",
    description: "查看 OpenClaw Harness 同步状态",
    owner: { kind: "core" },
    handler: async () => hs.status(),
  };
}

function makeConnectDetectDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const mgr = createAutoConnectManager(runtime);
  return {
    id: "connect.detect",
    verb: "acquire",
    description: "检测环境中所有可用服务（IM/AI/数据库/IoT）",
    owner: { kind: "core" },
    handler: async () => {
      const detected = await mgr.detect();
      return {
        services: detected,
        available: detected.filter((d) => d.available).map((d) => d.service),
        count_available: detected.filter((d) => d.available).length,
        count_total: detected.length,
      };
    },
  };
}

function makeConnectRecommendDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const mgr = createAutoConnectManager(runtime);
  return {
    id: "connect.recommend",
    verb: "query",
    description: "生成连接建议（告诉用户缺少哪些配置）",
    owner: { kind: "core" },
    handler: async () => {
      const recommendations = await mgr.generateRecommendations();
      return { recommendations };
    },
  };
}

function makeConnectStatusDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const mgr = createAutoConnectManager(runtime);
  return {
    id: "connect.status",
    verb: "query",
    description: "查看所有连接状态（已连接/未连接/建议）",
    owner: { kind: "core" },
    handler: async () => {
      const detected = await mgr.detect();
      return {
        connected: detected
          .filter((d) => d.available)
          .map((d) => ({ service: d.service, category: d.category })),
        disconnected: detected
          .filter((d) => !d.available)
          .map((d) => ({ service: d.service, category: d.category, missing: d.missingVars })),
      };
    },
  };
}

// ── perceive.* (感知理解) ─────────────────────────────────────────────────

function makePerceiveMessageDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.message",
    verb: "acquire",
    description: "理解一条消息：提取意图、实体、情绪、优先级",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        source: { type: "string", description: "消息来源渠道" },
        subject_id: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const completeFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;

      if (!completeFn) {
        return {
          status: "no_llm",
          intent: "unknown",
          entities: [],
          sentiment: "neutral",
          priority: "normal",
          summary: text.slice(0, 100),
        };
      }

      const prompt = [
        "你是工业机器人的消息分析助手。分析用户消息，严格输出 JSON，禁止输出任何解释或 markdown。",
        "",
        "intent 字段必须从以下列表中选一个：",
        "alarm_report | alarm_acknowledge | workorder_create | workorder_query | task_query | equipment_status | knowledge_query | system_status | shift_handover | report_request | help | chat | unknown",
        "",
        "输出格式（字段必须完整）：",
        '{"intent":"<意图名>","entities":["实体1","实体2"],"sentiment":"positive|neutral|negative","priority":"urgent|high|normal|low","summary":"一句话摘要","action_hint":"建议做什么"}',
        "",
        "示例：",
        '消息:"E001压缩机温度高报警" → {"intent":"alarm_report","entities":["E001","压缩机","温度高"],"sentiment":"negative","priority":"urgent","summary":"E001压缩机温度高报警","action_hint":"触发报警处理流程"}',
        '消息:"帮我查一下3号工单进度" → {"intent":"workorder_query","entities":["3号工单"],"sentiment":"neutral","priority":"normal","summary":"查询工单进度","action_hint":"调用工单查询能力"}',
        '消息:"今天日报发布了吗" → {"intent":"knowledge_query","entities":["日报"],"sentiment":"neutral","priority":"normal","summary":"查询今日日报","action_hint":"检索知识库日报内容"}',
        "",
        `消息: "${text}"`,
      ].join("\n");

      try {
        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const result = await completeFn({ prompt });
        const parsed = tryParseJson(result.text);
        return parsed ?? { status: "parse_failed", raw: result.text, intent: "unknown" };
      } catch {
        return { status: "error", intent: "unknown", summary: text.slice(0, 100) };
      }
    },
  };
}

function makePerceiveEntityDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.extract_entities",
    verb: "acquire",
    description: "从文本中提取结构化实体（人名、地点、时间、设备编号、工单号、班次等工业实体）",
    owner: { kind: "core" },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const completeFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
      if (!completeFn) {
        return { status: "no_llm", entities: [] };
      }

      const prompt = [
        "从以下文本提取实体，以JSON数组回答:",
        `文本: "${text}"`,
        "实体类型：person(人名), place(地点), time(时间), equipment_id(设备编号), work_order_id(工单号), alarm_id(报警号), shift(班次), amount(金额/数量), product(产品), org(组织), other(其他)",
        '格式: [{"type":"person|place|time|equipment_id|work_order_id|alarm_id|shift|amount|product|org|other","value":"...","confidence":0.0-1.0}]',
      ].join("\n");
      try {
        const result = await completeFn({ prompt });
        const raw = result.text.trim();
        const start = raw.indexOf("[");
        const end = raw.lastIndexOf("]");
        const parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
        return { status: "ok", entities: Array.isArray(parsed) ? parsed : [] };
      } catch {
        return { status: "error", entities: [] };
      }
    },
  };
}

function makePerceiveClassifyDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.classify",
    verb: "acquire",
    description: "将文本分类到预定义类别之一（传入 categories 列表，返回最匹配类别）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text", "categories"],
      properties: {
        text: { type: "string", description: "待分类文本" },
        categories: { type: "array", items: { type: "string" }, description: "候选类别列表" },
        context: { type: "string", description: "分类背景说明（可选）" },
      },
    },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const categories = Array.isArray(params.categories) ? (params.categories as string[]) : [];
      const context = String(params.context ?? "");
      if (categories.length === 0) {
        return { status: "error", reason: "categories 不能为空" };
      }

      const completeFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
      if (!completeFn) {
        return { status: "no_llm", category: categories[0], confidence: 0 };
      }

      const catList = categories.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const prompt = [
        "你是文本分类专家。从候选类别中选出最匹配的一个，严格输出 JSON，不要任何解释。",
        "",
        context ? `分类背景：${context}` : "",
        "",
        `候选类别：\n${catList}`,
        "",
        "示例：",
        `文本："设备报警了" 候选：alarm_report、workorder_query、chat → {"category":"alarm_report","confidence":0.95,"reason":"包含报警关键词"}`,
        `文本："你好" 候选：greeting、alarm_report、help → {"category":"greeting","confidence":0.99,"reason":"问候语"}`,
        "",
        `待分类文本："${text}"`,
        `输出格式：{"category":"类别名","confidence":0.0-1.0,"reason":"一句话理由"}`,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const result = await completeFn({ prompt });
        const parsed = tryParseJson(result.text);
        if (parsed && typeof parsed.category === "string") {
          return { status: "ok", ...parsed };
        }
        return { status: "parse_failed", category: categories[0], confidence: 0, raw: result.text };
      } catch {
        return { status: "error", category: categories[0], confidence: 0 };
      }
    },
  };
}

function makePerceiveIntentDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  // 意图分类结果 60 秒 TTL 缓存，避免同一分钟内对相同文本重复调用 LLM。
  // 闭包内定义，确保每个 runtime 实例拥有独立缓存，不会跨实例污染（如测试中）。
  const intentCache = new Map<string, { result: Record<string, unknown>; expiresAt: number }>();
  const INTENT_CACHE_TTL_MS = 60_000;
  const INTENT_CACHE_MAX = 200;

  function cacheIntentResult(key: string, result: Record<string, unknown>): void {
    if (intentCache.size >= INTENT_CACHE_MAX) {
      const firstKey = intentCache.keys().next().value;
      if (firstKey !== undefined) intentCache.delete(firstKey);
    }
    intentCache.set(key, { result, expiresAt: Date.now() + INTENT_CACHE_TTL_MS });
  }

  return {
    id: "perceive.intent",
    verb: "acquire",
    description:
      "理解消息意图并返回 suggested_capability / entities / confidence，供 Playbook 路由使用",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        channel: { type: "string" },
        user_id: { type: "string" },
      },
    },
    handler: async (ctx, params) => {
      const text = String(params.text ?? params.message ?? "");

      // 同一分钟内相同文本前缀命中缓存，直接返回（跳过 LLM 调用）
      const cacheKey = `${text.slice(0, 60)}\x00${Math.floor(Date.now() / INTENT_CACHE_TTL_MS)}`;
      const cached = intentCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      // 从 ContextEngine 注入最近 5 条会话历史，提升意图分类准确率
      const sessionId = String(params.user_id ?? params.session_id ?? ctx.runId ?? "default");
      const history = runtime.contextEngine?.getRecent(sessionId, 5) ?? [];

      // 使用 SystemPromptBuilder 构建结构化上下文段
      // 注：intent_classify 模板已有固定 system prompt；
      //   SystemPromptBuilder 仅用于生成上下文注入片段，追加到 message 末尾
      const userProfile = runtime.userProfileStore?.get(sessionId);
      const capabilityNames = runtime.capabilities
        .list()
        .slice(0, 20)
        .map((c) => c.id);

      // 查询 CBR 案例库：最相似的 2 条历史案例作为 few-shot 上下文
      // 帮助弱模型从已知成功案例中类比推断当前意图
      // 用 try/catch 保护：CBR 检索失败（DB 锁、索引错误等）不应阻断意图分类
      let cbrCases: string[] = [];
      try {
        cbrCases = runtime.cbrStore
          ? runtime.cbrStore
              .search(text, 2)
              .map((c) => {
                const p = c.problem as Record<string, unknown> | undefined;
                const prob =
                  typeof p?.problem === "string"
                    ? p.problem
                    : typeof c.problem === "string"
                      ? c.problem
                      : "";
                const sol = typeof c.solution === "string" ? c.solution : "";
                return prob && sol ? `示例：用户说"${prob}"→意图为"${sol}"` : null;
              })
              .filter((x): x is string => x !== null)
          : [];
      } catch {
        // CBR 不可用时忽略，降级为无 few-shot
      }

      const contextBlock = new SystemPromptBuilder()
        .withMemory([
          ...cbrCases,
          ...history.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`),
        ])
        .withUserProfile(
          userProfile
            ? {
                name: userProfile.name,
                style: userProfile.preferredResponseStyle,
                topics: userProfile.recentTopics,
              }
            : undefined,
        )
        .withCapabilities(capabilityNames)
        .build();

      // enrichedText: 用户消息 + 上下文（用于模板 message 槽）
      const enrichedText = contextBlock ? `${text}\n\n---\n${contextBlock}` : text;

      // 优先使用 structuredOutput 引擎 + promptRegistry intent_classify 模板
      // 弱模型补偿：强制输出符合 schema 的 JSON，失败自动重试
      if (runtime.structuredOutput && runtime.promptRegistry) {
        const llmCompleteFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
        if (llmCompleteFn) {
          try {
            const prompt = runtime.promptRegistry.render("intent_classify", {
              message: enrichedText,
            });
            const intentSchema = {
              type: "object" as const,
              required: ["intent", "confidence"],
              properties: {
                intent: { type: "string" as const, description: "意图分类结果" },
                confidence: { type: "number" as const, description: "置信度 0-1" },
                extracted: { type: "object" as const, description: "提取的实体" },
              },
            };
            // 优先 voting（3路采样多数投票），显著提升弱模型分类准确率。
            // 仅当 classify 模型与默认模型相同时跳过（避免强模型多余开销）。
            const classifyModel = runtime.modelRouter?.resolveForTask("classify");
            const defaultModel = runtime.modelRouter?.resolveForTask("chat");
            const useVoting = !!classifyModel && classifyModel !== defaultModel;
            const { data } = useVoting
              ? await runtime.structuredOutput.completeWithVoting(prompt, intentSchema, {
                  votes: 3,
                  voteField: "intent",
                  fallback: { intent: "unknown", confidence: 0, extracted: {} },
                })
              : await runtime.structuredOutput.complete(prompt, intentSchema, {
                  maxRetries: 3,
                  fallback: { intent: "unknown", confidence: 0, extracted: {} },
                });
            const intent = String(data.intent ?? "");
            if (intent && intent !== "unknown") {
              const hit = {
                status: "ok",
                intent,
                confidence: typeof data.confidence === "number" ? data.confidence : 0.8,
                extracted: (data.extracted as Record<string, string>) ?? {},
                suggested_capability: intent,
              };
              cacheIntentResult(cacheKey, hit);
              // 将成功识别的意图写入 CBR 案例库，供后续 few-shot 检索
              runtime.cbrStore?.add(text, intent, { confidence: hit.confidence });
              return hit;
            }
          } catch {
            // structuredOutput 失败时降级到 perceive.message
          }
        }
      }

      // 降级：委托 perceive.message（使用含历史的 enrichedText）
      const registry = runtime.capabilities;
      const perceiveHandler = registry.get("perceive.message");
      if (!perceiveHandler) {
        return {
          status: "no_perceive",
          suggested_capability: "",
          intent: "unknown",
          confidence: 0,
          entities: [],
        };
      }
      const result = await perceiveHandler.handler(ctx, { ...params, text: enrichedText });
      const finalResult = {
        ...result,
        suggested_capability: String(result.suggested_capability ?? result.intent ?? ""),
      };
      cacheIntentResult(cacheKey, finalResult);
      return finalResult;
    },
  };
}

// ── perceive.needs_clarification ────────────────────────────────────────────
// 改进 A：当意图置信度低时，生成追问问题，让机器人主动澄清而非盲目兜底。

function makePerceiveNeedsClarificationDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.needs_clarification",
    verb: "acquire",
    description: "当用户意图不明确时（置信度低），生成一个简短追问以澄清意图",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "用户原始消息" },
        intent_confidence: {
          type: "number",
          description: "意图分类置信度 0-1，低于阈值时触发追问",
        },
        context: { type: "string", description: "对话上下文补充" },
        threshold: {
          type: "number",
          description: "置信度阈值（默认 0.55）",
        },
      },
    },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const confidence =
        typeof params.intent_confidence === "number" ? params.intent_confidence : 1;
      const threshold = typeof params.threshold === "number" ? params.threshold : 0.55;

      if (confidence > threshold) {
        return { needs_clarification: false };
      }

      const llmFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
      if (!llmFn) {
        return { needs_clarification: false };
      }

      const contextHint = params.context ? `\n上下文：${String(params.context)}` : "";
      const prompt =
        `用户说："${text}"${contextHint}\n` +
        `我不太确定他的意思（置信度 ${(confidence * 100).toFixed(0)}%）。\n` +
        `请生成一个简短友好的追问（不超过 20 个字），帮助澄清用户意图。\n` +
        `只输出追问内容，不要解释，不要加引号。`;

      try {
        const raw = await llmFn(prompt);
        const question = (typeof raw === "string" ? raw : String(raw)).trim();
        if (question) {
          return { needs_clarification: true, clarification_question: question };
        }
      } catch {
        // LLM 失败时回退到不追问
      }
      return { needs_clarification: false };
    },
  };
}

// ── perceive.sentiment ───────────────────────────────────────────────────────
// 改进 D：感知用户情绪（紧急/平静/不满/满意），供 Playbook 调整优先级和措辞。

function makePerceiveSentimentDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.sentiment",
    verb: "acquire",
    description: "感知用户消息的情绪倾向（urgent/calm/frustrated/satisfied）和紧急程度 0-1",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const llmFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;

      if (!llmFn) {
        return { sentiment: "calm", urgency: 0.3, source: "fallback" };
      }

      const prompt =
        `你是情绪分析助手。判断消息的情绪状态，严格输出 JSON，不要任何解释。\n` +
        `输出格式：{"sentiment":"urgent|calm|frustrated|satisfied","urgency":0-1}\n` +
        `\n` +
        `示例：\n` +
        `消息："设备马上要爆炸了，快来！" → {"sentiment":"urgent","urgency":0.95}\n` +
        `消息："今天生产情况怎么样" → {"sentiment":"calm","urgency":0.2}\n` +
        `消息："为什么这个功能又不行了" → {"sentiment":"frustrated","urgency":0.6}\n` +
        `\n` +
        `消息："${text}"`;

      try {
        const raw = await llmFn(prompt);
        const cleaned = (typeof raw === "string" ? raw : String(raw))
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/```$/i, "");
        const parsed = JSON.parse(cleaned) as { sentiment?: string; urgency?: number };
        return {
          sentiment: parsed.sentiment ?? "calm",
          urgency: typeof parsed.urgency === "number" ? parsed.urgency : 0.3,
          source: "llm",
        };
      } catch {
        // 关键词兜底
        const urgentKeywords = [
          "紧急",
          "马上",
          "立刻",
          "快",
          "急",
          "!!",
          "！！",
          "告警",
          "宕机",
          "崩溃",
          "紧急求助",
          "故障",
          "异常",
          "中断",
          "挂了",
        ];
        const frustratedKeywords = ["为什么", "怎么回事", "不行", "不对", "差", "烂"];
        const text_lc = text.toLowerCase();
        if (urgentKeywords.some((k) => text_lc.includes(k))) {
          return { sentiment: "urgent", urgency: 0.9, source: "keyword" };
        }
        if (frustratedKeywords.some((k) => text_lc.includes(k))) {
          return { sentiment: "frustrated", urgency: 0.6, source: "keyword" };
        }
        return { sentiment: "calm", urgency: 0.3, source: "keyword" };
      }
    },
  };
}

// ── perceive.user_profile_update ─────────────────────────────────────────────
// 改进 B 辅助：更新用户画像（姓名、偏好风格、近期话题）

function makePerceiveUserProfileUpdateDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "perceive.user_profile_update",
    verb: "update",
    description: "更新用户画像（姓名、偏好风格、近期话题），供后续个性化回复使用",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["user_id"],
      properties: {
        user_id: { type: "string" },
        name: { type: "string" },
        topic: { type: "string", description: "本次对话话题，加入近期话题列表" },
        preferred_style: {
          type: "string",
          enum: ["concise", "detailed", "structured"],
        },
        custom_notes: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const userId = String(params.user_id ?? "");
      if (!userId || !runtime.userProfileStore) {
        return { updated: false };
      }
      runtime.userProfileStore.bump(userId);
      if (typeof params.name === "string") {
        runtime.userProfileStore.setName(userId, params.name);
      }
      if (typeof params.topic === "string" && params.topic) {
        runtime.userProfileStore.addTopic(userId, params.topic);
      }
      if (
        typeof params.preferred_style === "string" &&
        ["concise", "detailed", "structured"].includes(params.preferred_style)
      ) {
        runtime.userProfileStore.update(userId, {
          preferredResponseStyle: params.preferred_style as "concise" | "detailed" | "structured",
        });
      }
      if (typeof params.custom_notes === "string") {
        runtime.userProfileStore.update(userId, { customNotes: params.custom_notes });
      }
      return {
        updated: true,
        profile: runtime.userProfileStore.get(userId),
      };
    },
  };
}

// ── time.* (时间感知) ─────────────────────────────────────────────────────

/** 工业班次定义：早/中/晚/夜 */
function resolveShift(hour: number): { shift: string; shift_name: string; next_shift: string } {
  if (hour >= 6 && hour < 14) {
    return { shift: "morning", shift_name: "早班", next_shift: "afternoon" };
  }
  if (hour >= 14 && hour < 22) {
    return { shift: "afternoon", shift_name: "中班", next_shift: "night" };
  }
  return { shift: "night", shift_name: "夜班", next_shift: "morning" };
}

function makeTimeNowDescriptor(): CapabilityDescriptor {
  return {
    id: "time.now",
    verb: "query",
    description: "返回当前时间（ISO格式、Unix时间戳、人类可读格式）",
    owner: { kind: "core" },
    handler: async () => {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, "0");
      return {
        iso: now.toISOString(),
        unix: Math.floor(now.getTime() / 1000),
        unix_ms: now.getTime(),
        human: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday: now.toLocaleDateString("zh-CN", { weekday: "long" }),
      };
    },
  };
}

function makeTimeShiftDescriptor(): CapabilityDescriptor {
  return {
    id: "time.shift",
    verb: "query",
    description: "返回当前班次（早/中/晚/夜），及下一班次信息",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        hour: { type: "number", description: "指定小时（0-23），不填则用当前时间" },
      },
    },
    handler: async (_ctx, params) => {
      const hour = typeof params.hour === "number" ? params.hour : new Date().getHours();
      const shiftInfo = resolveShift(hour);
      const now = new Date();
      return {
        ...shiftInfo,
        current_hour: hour,
        date: now.toISOString().slice(0, 10),
      };
    },
  };
}

function makeTimeParsDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "time.parse",
    verb: "acquire",
    description: "解析自然语言时间表达式为 ISO 格式（如'明天上午9点'→ISO时间）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "自然语言时间描述" },
        reference: { type: "string", description: "参考时间（ISO格式），默认当前时间" },
      },
    },
    handler: async (_ctx, params) => {
      const text = String(params.text ?? "");
      const reference = params.reference ? new Date(String(params.reference)) : new Date();
      if (Number.isNaN(reference.getTime())) {
        return { status: "invalid_reference" };
      }

      // 规则解析常见表达式（无需 LLM）
      const now = reference;
      const pad = (n: number) => n.toString().padStart(2, "0");
      const todayBase = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const ruleMap: Array<[RegExp, () => Date]> = [
        [/现在|此刻|当前/, () => now],
        [/今天/, () => todayBase],
        [/明天/, () => new Date(todayBase.getTime() + 86_400_000)],
        [/后天/, () => new Date(todayBase.getTime() + 2 * 86_400_000)],
        [/昨天/, () => new Date(todayBase.getTime() - 86_400_000)],
        [/下周/, () => new Date(todayBase.getTime() + 7 * 86_400_000)],
      ];

      let baseDate: Date | null = null;
      for (const [pattern, fn] of ruleMap) {
        if (pattern.test(text)) {
          baseDate = fn();
          break;
        }
      }

      // 提取小时
      const hourMatch = text.match(/(\d{1,2})[点:时]/);
      if (hourMatch && baseDate) {
        baseDate.setHours(Number.parseInt(hourMatch[1]), 0, 0, 0);
        if (text.includes("下午") || text.includes("晚上")) {
          const h = baseDate.getHours();
          if (h < 12) {
            baseDate.setHours(h + 12);
          }
        }
      }

      if (baseDate && !Number.isNaN(baseDate.getTime())) {
        return {
          status: "ok",
          iso: baseDate.toISOString(),
          unix: Math.floor(baseDate.getTime() / 1000),
          human: `${baseDate.getFullYear()}-${pad(baseDate.getMonth() + 1)}-${pad(baseDate.getDate())} ${pad(baseDate.getHours())}:${pad(baseDate.getMinutes())}`,
          input: text,
          method: "rule",
        };
      }

      // 降级：用 LLM 解析
      const completeFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
      if (!completeFn) {
        return { status: "unparsed", input: text };
      }

      const prompt = `将"${text}"转换为ISO 8601时间格式。参考时间：${now.toISOString()}。只输出JSON：{"iso":"...","human":"YYYY-MM-DD HH:mm","confidence":0.0-1.0}`;
      try {
        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const result = await completeFn({ prompt });
        const parsed = tryParseJson(result.text);
        return parsed
          ? { status: "ok", ...parsed, input: text, method: "llm" }
          : { status: "unparsed", input: text };
      } catch {
        return { status: "error", input: text };
      }
    },
  };
}

function makeTimeDiffDescriptor(): CapabilityDescriptor {
  return {
    id: "time.diff",
    verb: "transform",
    description: "计算两个时间点之间的差值（秒/分钟/小时/天）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string", description: "起始时间（ISO格式）" },
        to: { type: "string", description: "结束时间（ISO格式）" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days"],
          description: "返回单位，默认 seconds",
        },
      },
    },
    handler: async (_ctx, params) => {
      const from = new Date(String(params.from ?? ""));
      const to = new Date(String(params.to ?? ""));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return { status: "invalid_time", from: String(params.from), to: String(params.to) };
      }
      const diffMs = to.getTime() - from.getTime();
      const unit = String(params.unit ?? "seconds");
      const divisors: Record<string, number> = {
        seconds: 1000,
        minutes: 60_000,
        hours: 3_600_000,
        days: 86_400_000,
      };
      const value = diffMs / (divisors[unit] ?? 1000);
      return {
        status: "ok",
        value: Math.round(value * 100) / 100,
        unit,
        diff_ms: diffMs,
        from: from.toISOString(),
        to: to.toISOString(),
        negative: diffMs < 0,
      };
    },
  };
}

// ── learn.* (主动学习) ────────────────────────────────────────────────────

function makeLearnObserveDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "learn.observe",
    verb: "acquire",
    description:
      "将机器人主动观察到的现象（事件、异常、规律）写入知识库。" +
      "适用于：运行时发现异常需要记录、Playbook 步骤中捕获中间状态、定时观察任务写入环境数据。" +
      "与 learn.from_feedback 的区别：observe 是机器人主动记录，feedback 是用户主动评价。",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["observation"],
      properties: {
        observation: { type: "string" },
        context: { type: "string" },
        importance: { type: "string", enum: ["low", "normal", "high"] },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (_ctx, params) => {
      const obs = String(params.observation ?? "");
      const contextStr = String(params.context ?? "");
      const importance = String(params.importance ?? "normal");
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : ["observation"];

      const content = contextStr
        ? `[${importance}] ${obs}\n\nContext: ${contextStr}`
        : `[${importance}] ${obs}`;
      await runtime.kb.ingest(content, { source: "learn.observe" });
      const id = "ingested";

      await runtime.kernel.publish("learn.observation_recorded", "learn.observe", {
        id,
        observation: obs,
        importance,
        tags,
      });

      return { status: "ok", id, observation: obs };
    },
  };
}

function makeLearnFromFeedbackDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "learn.from_feedback",
    verb: "acquire",
    description:
      "处理用户对机器人回复的显式反馈（好/坏/纠正）。" +
      "correction 类型会立即写入 RuleEngine 规则（秒级生效）和 CBR 案例库，无需等待进化包。" +
      "negative 类型累计 3 次会触发 AutonomyEngine 学习机会检测。" +
      "与 learn.observe 区别：feedback 是用户主动评价，observe 是机器人被动记录观察。",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["feedback_type", "content"],
      properties: {
        feedback_type: { type: "string", enum: ["positive", "negative", "correction"] },
        content: { type: "string", description: "用户原始输入或被评价的内容" },
        related_run_id: { type: "string" },
        correction: {
          type: "string",
          description: "用户给出的正确意图/答案（correction 类型必填）",
        },
        intent: { type: "string", description: "被纠正的原始意图标识" },
      },
    },
    handler: async (_ctx, params) => {
      const type = String(params.feedback_type ?? "positive");
      const content = String(params.content ?? "");
      const correction = String(params.correction ?? "");
      const intent = params.intent ? String(params.intent) : undefined;

      const entry = correction
        ? `[feedback:${type}] ${content}\n\nCorrection: ${correction}`
        : `[feedback:${type}] ${content}`;

      await runtime.kb.ingest(entry, { source: "learn.from_feedback" });
      const id = "ingested";

      // 将纠正案例写入 CBR 案例库，直接改善未来 few-shot 意图识别
      if (intent && (type === "positive" || type === "correction")) {
        const solution = correction || intent;
        runtime.cbrStore?.add(content, solution, {
          confidence: type === "correction" ? 0.95 : 0.85,
        });
      }

      // 快速在线规则学习：correction 时立即将关键词→意图映射写入 RuleEngine
      // 下次相同/相似输入直接命中规则，跳过 LLM，秒级生效
      let ruleAdded = false;
      if (type === "correction" && correction && content && runtime.ruleEngine?.addRule) {
        const ruleId = `learned-${Date.now()}`;
        const trigger = content.slice(0, 50);
        runtime.ruleEngine.addRule("im.quick_rules", {
          id: ruleId,
          name: `用户纠正学习：${trigger.slice(0, 20)}`,
          priority: 900,
          condition: { field: "text", op: "contains", value: trigger },
          action: {
            kind: "publish_event",
            params: { event_type: `im.intent.${correction.replace(/[^a-z0-9_.]/gi, "_")}` },
          },
          stopOnMatch: true,
        });
        ruleAdded = true;
        await runtime.kernel.publish("learn.rule_added", "learn.from_feedback", {
          rule_id: ruleId,
          trigger,
          intent: correction,
          source: "user_correction",
        });
      }

      // 通知 AutonomyEngine 记录反馈，负反馈累积到阈值时触发学习机会检测
      const { recordFeedback } = await import("./autonomy-engine.js");
      await recordFeedback(runtime, {
        input: content,
        intent,
        feedback: type === "negative" ? "negative" : "positive",
        note: correction || undefined,
      });

      await runtime.kernel.publish("learn.feedback_recorded", "learn.from_feedback", {
        id,
        feedback_type: type,
        content,
        related_run_id: params.related_run_id,
      });

      return { status: "ok", id, feedback_type: type, rule_added: ruleAdded };
    },
  };
}

// ── evolve.* (自我进化) ───────────────────────────────────────────────────
//
// L8 进化能力层。全部委托给 EvolveEngine（LLM 驱动的 Playbook 生成/部署/验证/学习）。
// EvolveEngine 单例懒创建：第一次调用时初始化，后续复用。

let _evolveEngineInstance: ReturnType<typeof createEvolveEngine> | undefined;

function getOrCreateEvolveEngine(runtime: ClaworksRuntime): ReturnType<typeof createEvolveEngine> {
  if (!_evolveEngineInstance) {
    _evolveEngineInstance = createEvolveEngine(runtime);
    // 同时挂到 runtime 上，便于 extension-capabilities / 上层访问
    (runtime as { evolveEngine?: ReturnType<typeof createEvolveEngine> }).evolveEngine =
      _evolveEngineInstance;
  }
  return _evolveEngineInstance;
}

function makeEvolveDiscoverDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.discover",
    verb: "acquire",
    description: "主动发现环境中未被充分利用的接口或能力，生成改进建议",
    owner: { kind: "core" },
    handler: async () => {
      const connectorIds = Object.keys(runtime.config.connectors ?? {});
      const capabilities = runtime.capabilities.listAll();
      const packs = runtime.loadedPacks.map((p) => p.manifest.id);

      const underutilized = connectorIds.filter((id) => {
        const hasPlaybook = runtime.playbookEngine
          .list()
          .some((pb) => JSON.stringify(pb).includes(id));
        return !hasPlaybook;
      });

      const suggestions: string[] = [];
      for (const id of underutilized) {
        suggestions.push(
          `Connector '${id}' has no Playbook. Consider probing it with autonomy.probe_interface.`,
        );
      }
      if (capabilities.length < 20) {
        suggestions.push(
          "Capability count is low. Install more Packs via nexus to expand robot abilities.",
        );
      }
      if (packs.length === 0) {
        suggestions.push("No Packs loaded. Install the 'base' pack to get started.");
      }

      await runtime.kernel.publish("evolve.suggestions_ready", "evolve.discover", {
        suggestions,
        connector_count: connectorIds.length,
        capability_count: capabilities.length,
        pack_count: packs.length,
      });

      return { status: "ok", suggestions, underutilized_connectors: underutilized };
    },
  };
}

function makeEvolveWritePlaybookDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.write_playbook",
    verb: "compose",
    description:
      "根据描述让 LLM 生成一个 Playbook YAML 并保存为草稿（旧接口，建议改用 evolve.propose）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string", description: "想要实现的任务描述" },
        available_actions: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (_ctx, params) => {
      const description = String(params.description ?? "");
      const engine = getOrCreateEvolveEngine(runtime);
      try {
        const proposal = await engine.propose({ description });
        // 兼容旧接口：写入 KB
        await runtime.kb.ingest(proposal.playbook_yaml, { source: "evolve.write_playbook" });
        await runtime.kernel.publish("evolve.playbook_drafted", "evolve.write_playbook", {
          id: proposal.id,
          description,
        });
        return { status: "ok", draft_id: proposal.id, yaml: proposal.playbook_yaml, proposal };
      } catch (err) {
        return { status: "error", reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeEvolveProposDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.propose",
    verb: "acquire",
    description: "分析用户需求，LLM 生成完整 Playbook 方案（含 YAML、置信度、缺失能力分析）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string", description: "用户的需求描述（自然语言）" },
        context: { type: "string", description: "额外上下文（当前状态、已有配置等）" },
      },
    },
    handler: async (_ctx, params) => {
      const { description, context } = params as { description: string; context?: string };
      const engine = getOrCreateEvolveEngine(runtime);
      const proposal = await engine.propose({ description, context });
      return proposal as unknown as Record<string, unknown>;
    },
  };
}

function makeEvolveDeployDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.deploy",
    verb: "execute",
    description: "将 EvolveProposal 部署到运行时（写文件 + packLoader.load() 热重载）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["proposal"],
      properties: {
        proposal: { type: "object", description: "evolve.propose 返回的 EvolveProposal" },
        pack_id: { type: "string", description: "目标 Pack ID，默认 user_evolved" },
      },
    },
    handler: async (_ctx, params) => {
      const proposal = params.proposal as EvolveProposal;
      const packId = params.pack_id as string | undefined;
      const engine = getOrCreateEvolveEngine(runtime);
      const result = await engine.deploy(proposal, { packId });
      return result as unknown as Record<string, unknown>;
    },
  };
}

function makeEvolveVerifyDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.verify",
    verb: "acquire",
    description: "发布测试事件，验证已部署的 Playbook 是否在 5s 内正确触发",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["playbook_id", "test_event"],
      properties: {
        playbook_id: { type: "string" },
        test_event: { type: "string" },
        test_payload: { type: "object", description: "测试载荷，默认 {}" },
      },
    },
    handler: async (_ctx, params) => {
      const {
        playbook_id,
        test_event,
        test_payload = {},
      } = params as {
        playbook_id: string;
        test_event: string;
        test_payload?: Record<string, unknown>;
      };
      const engine = getOrCreateEvolveEngine(runtime);
      const result = await engine.verify(playbook_id, test_event, test_payload);
      return result as unknown as Record<string, unknown>;
    },
  };
}

function makeEvolveLearnDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.learn",
    verb: "execute",
    description: "将进化结果（EvolveResult）写入 CbrStore，供后续相似需求参考",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["result"],
      properties: {
        result: { type: "object", description: "evolve.deploy 返回的 EvolveResult" },
        feedback: { type: "string", description: "用户对本次执行的反馈" },
      },
    },
    handler: async (_ctx, params) => {
      const { result, feedback } = params as { result: EvolveResult; feedback?: string };
      const engine = getOrCreateEvolveEngine(runtime);
      const caseId = await engine.learn(result, feedback);
      return { learned: true, cbr_case_id: caseId };
    },
  };
}

function makeEvolveListDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.list",
    verb: "query",
    description: "列出用户通过对话自动生成的所有 Playbook（来自 user_evolved Pack）",
    owner: { kind: "core" },
    handler: async () => {
      const engine = getOrCreateEvolveEngine(runtime);
      const evolved = await engine.listEvolved();
      return { evolved, count: evolved.length };
    },
  };
}

function makeEvolveRemoveDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.remove",
    verb: "execute",
    description: "移除一个进化的 Playbook（删文件 + 引擎卸载）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["playbook_id"],
      properties: {
        playbook_id: { type: "string", description: "要移除的 Playbook ID" },
      },
    },
    handler: async (_ctx, params) => {
      const { playbook_id } = params as { playbook_id: string };
      const engine = getOrCreateEvolveEngine(runtime);
      await engine.remove(playbook_id);
      return { removed: true, playbook_id };
    },
  };
}

function makeEvolveFullCycleDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "evolve.full_cycle",
    verb: "execute",
    description: "完整进化循环：理解需求 → LLM 生成方案 → (HITL 确认) → 部署 → 验证 → CBR 学习",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string", description: "用户的需求描述" },
        auto_approve: {
          type: "boolean" as const,
          description: "置信度 >= 0.7 时自动跳过 HITL，默认 false",
        } as { type: "boolean"; description: string },
        context: { type: "string" },
      },
    },
    handler: async (ctx, params) => {
      const {
        description,
        auto_approve = false,
        context,
      } = params as {
        description: string;
        auto_approve?: boolean;
        context?: string;
      };
      const engine = getOrCreateEvolveEngine(runtime);

      // Step 1: 生成方案
      const proposal = await engine.propose({ description, context });

      // Step 2: 低置信度 + 非自动审批时，发起 HITL 请求
      if (!auto_approve && proposal.confidence < 0.7) {
        await runtime.kernel.publish("hitl.approval_requested", ctx.source ?? "evolve", {
          gate_id: `evolve-${proposal.id}`,
          message: [
            `我生成了以下 Playbook 方案，是否部署？`,
            ``,
            `**${proposal.title}**`,
            proposal.description,
            ``,
            `置信度：${(proposal.confidence * 100).toFixed(0)}%`,
            proposal.warnings.length > 0 ? `⚠️ 注意：${proposal.warnings.join("、")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          proposal_id: proposal.id,
          preview: proposal.playbook_yaml.slice(0, 500),
        });
        return { status: "awaiting_approval", proposal };
      }

      // Step 3: 部署
      const deployResult = await engine.deploy(proposal);

      // Step 4: 验证（仅当部署成功）
      if (deployResult.deployed) {
        const verifyResult = await engine.verify(
          proposal.id,
          proposal.test_event,
          proposal.test_payload,
        );
        deployResult.test_passed = verifyResult.passed;
        deployResult.test_output = verifyResult.output;
      }

      // Step 5: 写入 CBR 学习
      const cbrCaseId = await engine.learn(deployResult);
      deployResult.cbr_case_id = cbrCaseId;

      await runtime.kernel.publish("evolve.playbook_deployed", "evolve.full_cycle", {
        playbook_id: proposal.id,
        title: proposal.title,
        deployed: deployResult.deployed,
        test_passed: deployResult.test_passed,
        playbook_path: deployResult.playbook_path,
      });

      return {
        status: deployResult.test_passed
          ? "success"
          : deployResult.deployed
            ? "deployed_unverified"
            : "deploy_failed",
        proposal,
        deployed: deployResult.deployed,
        test_passed: deployResult.test_passed,
        playbook_path: deployResult.playbook_path,
        cbr_case_id: cbrCaseId,
      };
    },
  };
}

// ── prompt.* ──────────────────────────────────────────────────────────────

function makePromptListDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "prompt.list",
    verb: "query",
    description: "列出所有已注册的 Prompt 模板（id、名称、输出格式）",
    owner: { kind: "core" },
    handler: async () => {
      const registry = runtime.promptRegistry;
      if (!registry) {
        return { templates: [], count: 0, note: "promptRegistry 未注入" };
      }
      return {
        templates: registry.list().map((t) => ({
          id: t.id,
          description: t.description ?? "",
        })),
        count: registry.list().length,
      };
    },
  };
}

function makePromptRenderDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "prompt.render",
    verb: "compose",
    description: "渲染 Prompt 模板，替换 {{variable}} 占位符，返回 system + user 文本",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["template_id", "variables"],
      properties: {
        template_id: { type: "string", description: "模板 ID（如 intent_classify）" },
        variables: { type: "object", description: "占位符变量键值对" },
      },
    },
    handler: async (_ctx, params) => {
      const id = String(params.template_id ?? "");
      const variables = (params.variables as Record<string, string> | undefined) ?? {};
      try {
        const rendered = runtime.promptRegistry?.render(id, variables) ?? "";
        return {
          status: "ok",
          ...(typeof rendered === "object" && rendered !== null
            ? (rendered as Record<string, unknown>)
            : {}),
        };
      } catch (err) {
        return {
          status: "not_found",
          template_id: id,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ── llm.* (LLM 增强：弱模型补偿) ─────────────────────────────────────────

function makeLlmStructuredCompleteDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "llm.structured_complete",
    verb: "compose",
    description:
      "调用 LLM 并保证输出符合 JSON schema（结构化输出引擎）；失败自动重试最多 max_retries 次。弱模型补偿核心能力。",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["prompt", "schema"],
      properties: {
        prompt: { type: "string" },
        schema: { type: "object", description: "JSON Schema 对象（OutputSchema）" },
        max_retries: { type: "number", description: "最大重试次数，默认 3" },
        fallback: { type: "object", description: "全部失败时的兜底值" },
        task_type: { type: "string", description: "任务类型（用于模型路由）" },
      },
    },
    handler: async (_ctx, params) => {
      const prompt = String(params.prompt ?? "");
      const schema = params.schema as import("./structured-output.js").OutputSchema | undefined;
      if (!schema) {
        return { status: "error", reason: "schema 参数缺失" };
      }

      if (!runtime.structuredOutput) {
        return { status: "no_structured_output", reason: "结构化输出引擎未初始化" };
      }

      try {
        const result = await runtime.structuredOutput.complete(prompt, schema, {
          maxRetries: typeof params.max_retries === "number" ? params.max_retries : 3,
          fallback: params.fallback as Record<string, unknown> | undefined,
        });
        return { status: "ok", ...result };
      } catch (err) {
        return {
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ── robot.* ─────────────────────────────────────────────────────────────────

function makeRobotWhoamiDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.whoami",
    verb: "query",
    description: "机器人自我介绍（'我是谁？'）",
    owner: { kind: "core" },
    handler: async () => {
      const idMgr = (
        runtime as unknown as {
          robotIdentityManager?: {
            buildIntroduction: (l?: string) => string;
            getIdentity: () => Record<string, unknown>;
          };
        }
      ).robotIdentityManager;
      if (idMgr) {
        return { text: idMgr.buildIntroduction(), identity: idMgr.getIdentity() };
      }
      return {
        text: `我是 ${runtime.robot.name}，您的${runtime.robot.role}。`,
        name: runtime.robot.name,
        role: runtime.robot.role,
        version: runtime.robot.version,
      };
    },
  };
}

function makeRobotIdentityDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.identity",
    verb: "query",
    description: "返回机器人完整身份信息（管理员可见）",
    owner: { kind: "core" },
    handler: async () => {
      const idMgr = (
        runtime as unknown as {
          robotIdentityManager?: { getIdentity: () => Record<string, unknown> };
        }
      ).robotIdentityManager;
      if (idMgr) {
        return idMgr.getIdentity();
      }
      return {
        name: runtime.robot.name,
        role: runtime.robot.role,
        version: runtime.robot.version,
        endpoint: runtime.robot.endpoint,
      };
    },
  };
}

function makeRobotOwnerDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.owner",
    verb: "query",
    description: "返回机器人主人信息",
    owner: { kind: "core" },
    handler: async () => {
      const idMgr = (
        runtime as unknown as {
          robotIdentityManager?: { getIdentity: () => { owner?: Record<string, unknown> } };
        }
      ).robotIdentityManager;
      if (idMgr) {
        const id = idMgr.getIdentity();
        return id.owner ? { owner: id.owner } : { owner: null, message: "未设置主人" };
      }
      const owner = runtime.identity.owner;
      return owner ? { owner } : { owner: null };
    },
  };
}

function makeRobotRelationsDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.relations",
    verb: "query",
    description: "返回关系人列表（管理员可见）",
    owner: { kind: "core" },
    handler: async () => {
      const idMgr = (
        runtime as unknown as { robotIdentityManager?: { listRelations: () => unknown[] } }
      ).robotIdentityManager;
      if (idMgr) {
        const relations = idMgr.listRelations();
        return { relations, count: relations.length };
      }
      return { relations: [], count: 0 };
    },
  };
}

function makeRobotAddRelationDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.add_relation",
    verb: "modify",
    description: "添加关系人（管理员权限）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["userId", "name", "role"],
      properties: {
        userId: { type: "string" },
        name: { type: "string" },
        role: { type: "string", enum: ["owner", "admin", "operator", "guest", "peer_robot"] },
        channels: { type: "array", items: { type: "string" } },
        bindingSubjects: { type: "array", items: { type: "string" } },
        note: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const idMgr = (
        runtime as unknown as {
          robotIdentityManager?: {
            addRelation: (r: unknown) => unknown;
            persist: (db: unknown) => Promise<void>;
          };
        }
      ).robotIdentityManager;
      if (idMgr) {
        const rel = idMgr.addRelation({
          userId: String(params.userId ?? ""),
          name: String(params.name ?? ""),
          role: String(params.role ?? "guest") as
            | "owner"
            | "admin"
            | "operator"
            | "guest"
            | "peer_robot",
          channels: Array.isArray(params.channels) ? (params.channels as string[]) : [],
          bindingSubjects: Array.isArray(params.bindingSubjects)
            ? (params.bindingSubjects as string[])
            : [],
          note: typeof params.note === "string" ? params.note : undefined,
        });
        // 持久化到 DB，防止重启后关系丢失
        if (runtime.db) {
          await idMgr.persist(runtime.db).catch(() => undefined);
        }
        return { status: "ok", relation: rel };
      }
      return { status: "not_supported", message: "身份管理器未初始化" };
    },
  };
}

function makeRobotIntroduceDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "robot.introduce",
    verb: "query",
    description: "生成完整的自我介绍卡片（Markdown + 能力列表）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        lang: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const lang = typeof params.lang === "string" ? params.lang : "zh-CN";
      const idMgr = (
        runtime as unknown as {
          robotIdentityManager?: {
            buildIntroduction: (l?: string) => string;
            getIdentity: () => {
              name: string;
              role: string;
              organization: string;
              capabilities_summary: string;
            };
          };
        }
      ).robotIdentityManager;

      const caps = runtime.capabilities.list();
      const packCount = runtime.loadedPacks.length;
      const playbookCount = runtime.playbookEngine.list().length;

      if (idMgr) {
        const id = idMgr.getIdentity();
        const intro = idMgr.buildIntroduction(lang);
        const capsSummary = caps
          .slice(0, 10)
          .map((c) => `• **${c.id}** — ${c.description}`)
          .join("\n");
        const cardText = `## 🤖 ${id.name}\n\n${intro}\n\n**已注册能力（${caps.length} 个，部分展示）：**\n${capsSummary}\n\n📦 已加载 Pack：${packCount} 个 | 📋 Playbook：${playbookCount} 个`;
        return {
          text: cardText,
          card_template: "robot_intro",
          card_data: {
            name: id.name,
            role: id.role,
            organization: id.organization,
            capabilities_count: caps.length,
            packs_count: packCount,
            playbooks_count: playbookCount,
            capabilities_summary: id.capabilities_summary,
          },
        };
      }

      const capsSummary = caps
        .slice(0, 10)
        .map((c) => `• **${c.id}** — ${c.description}`)
        .join("\n");
      const text = `## 🤖 ${runtime.robot.name}\n\n我是 ${runtime.robot.name}，您的${runtime.robot.role}。\n\n**已注册能力（${caps.length} 个，部分展示）：**\n${capsSummary}\n\n📦 已加载 Pack：${packCount} 个 | 📋 Playbook：${playbookCount} 个`;
      return {
        text,
        card_template: "robot_intro",
        card_data: {
          name: runtime.robot.name,
          role: runtime.robot.role,
          capabilities_count: caps.length,
          packs_count: packCount,
          playbooks_count: playbookCount,
        },
      };
    },
  };
}

// ── kb.ingest_document（长文档自动分块）──────────────────────────────────────

function makeKbIngestDocumentDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "kb.ingest_document",
    verb: "acquire",
    description: "摄入长文档（自动按段落/标题分块，每块作为独立条目）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["content", "title"],
      properties: {
        content: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        chunk_size: { type: "integer", default: 500 },
        tags: { type: "array", items: { type: "string" } },
        namespace: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const content = String(params.content ?? "");
      const title = String(params.title ?? "untitled");
      const source = typeof params.source === "string" ? params.source : "kb.ingest_document";
      const chunkSize = typeof params.chunk_size === "number" ? params.chunk_size : 500;

      // 按段落/标题分块
      const chunks = chunkDocument(content, chunkSize);
      const ids: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await runtime.kb.ingest(chunk, { source });
        const id = "ingested";
        ids.push(id);
      }

      return {
        chunks_created: chunks.length,
        total_chars: content.length,
        chunk_ids: ids,
        title,
      };
    },
  };
}

/**
 * 将长文档切分为 chunk_size 大小的段落块。
 * 优先按 Markdown 标题（#）或空行分割，不满足时强制截断。
 */
function chunkDocument(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  // 先按段落（双换行）分割
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  // 如果某个 chunk 仍然过长，强制截断
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= chunkSize * 2) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += chunkSize) {
        result.push(chunk.slice(i, i + chunkSize));
      }
    }
  }

  return result.filter(Boolean);
}

// ── environment.learn_from_fs / environment.web_search / connect.apply ────

function makeEnvironmentLearnFromFsDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const scanner = createEnvironmentScanner();
  return {
    id: "environment.learn_from_fs",
    verb: "acquire",
    description: "扫描文件系统路径，将重要配置/文档/代码摘要写入知识库",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "扫描路径列表，默认当前目录",
        },
        max_files: { type: "integer", default: 50, description: "最多摄入文件数" },
        file_types: {
          type: "array",
          items: { type: "string" },
          description: "文件类型过滤（扩展名）",
        },
      },
    },
    handler: async (_ctx, params) => {
      const paths = Array.isArray(params.paths) ? (params.paths as string[]) : [process.cwd()];
      const maxFiles = typeof params.max_files === "number" ? params.max_files : 50;
      const fileTypes = Array.isArray(params.file_types)
        ? (params.file_types as string[])
        : ["md", "json", "yaml", "txt"];

      const resources = await scanner.scanFileSystem(paths, {
        patterns: fileTypes.map((t: string) => `*.${t}`),
        maxDepth: 3,
      });

      let ingested = 0;
      for (const r of resources.slice(0, maxFiles)) {
        try {
          const content = await readFile(r.location, "utf8").catch(() => "");
          if (content.length > 0 && content.length < 50_000) {
            await runtime.kb.ingest(
              `文件：${r.name}\n路径：${r.location}\n内容摘要：\n${content.slice(0, 2000)}`,
              { source: "filesystem" },
            );
            ingested++;
          }
        } catch {
          // 单个文件失败不中断
        }
      }

      return { scanned: resources.length, ingested, paths };
    },
  };
}

function makeEnvironmentWebSearchDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const scanner = createEnvironmentScanner();
  return {
    id: "environment.web_search",
    verb: "acquire",
    description:
      "搜索互联网获取信息，并可选写入知识库（需配置 SEARXNG_URL / BRAVE_SEARCH_API_KEY / SERPER_API_KEY）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "搜索关键词" },
        save_to_kb: { type: "boolean", default: false, description: "是否将结果写入知识库" },
        limit: { type: "integer", default: 5, description: "返回结果数" },
      },
    },
    handler: async (_ctx, params) => {
      const query = String(params.query ?? "");
      const saveToKb = params.save_to_kb === true;
      const limit = typeof params.limit === "number" ? params.limit : 5;

      const results = await scanner.webSearch(query, limit);

      if (saveToKb && results.length > 0) {
        for (const r of results) {
          await runtime.kb.ingest(`标题：${r.title}\nURL：${r.url}\n摘要：${r.snippet}`, {
            source: `web_search:${query}`,
          });
        }
      }

      return { results, saved: saveToKb ? results.length : 0, query };
    },
  };
}

function makeConnectApplyDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  const mgr = createAutoConnectManager(runtime);
  return {
    id: "connect.apply",
    verb: "control",
    description: "实际应用连接配置（从环境变量读取凭证并更新运行时连接器配置）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["services"],
      properties: {
        services: {
          type: "array",
          items: { type: "string" },
          description: "要连接的服务列表（feishu/ollama/openai/...）",
        },
      },
    },
    handler: async (_ctx, params) => {
      const services = Array.isArray(params.services) ? (params.services as string[]) : [];
      const results = await mgr.applyConnections(services);
      return { results, applied: results.filter((r) => r.status === "connected").length };
    },
  };
}

// ── 工厂：注册所有核心能力 ────────────────────────────────────────────────

/**
 * 创建并初始化所有核心基础能力注册表。
 * 在 createClaworksRuntime 中调用，在任何 Pack 加载之前完成。
 *
 * 能力分层（共 31 个）：
 *   L0 system.*        生命维持（3 个 + system.describe）
 *   L1 environment.*   感知环境（2 个）
 *   L2 kb.*            记忆（3 个）
 *   L3 perceive.*      感知理解（3 个：perceive.message / extract_entities / intent）
 *   L3+ perceive增强   类人交互（3 个：needs_clarification / sentiment / user_profile_update）
 *   L4 task.*          执行（2 个）
 *   L5 object.*        实体操作（3 个）
 *   L6 event.*         事件（1 个）
 *   L7 learn.*         主动学习（3 个）
 *   L8 evolve.*        自我进化（9 个：discover / write_playbook / propose / deploy / verify / learn / list / remove / full_cycle）
 *   L9 message.*       兜底（1 个）
 *   Lx prompt.*        Prompt 模板（2 个）
 *   Lx llm.*           LLM 增强（1 个：llm.structured_complete）
 */
export function createCoreCapabilityRegistry(runtime: ClaworksRuntime): CapabilityRegistry {
  const registry = createCapabilityRegistry();

  const descriptors: CapabilityDescriptor[] = [
    // L0: 生命维持
    makeSystemHealthDescriptor(runtime),
    makeSystemStatusDescriptor(runtime),
    makeSystemVersionDescriptor(runtime),
    makeSystemStatsDescriptor(runtime),
    makeSystemPackListDescriptor(runtime),
    makeSystemLearnDescriptor(runtime),

    // L1: 感知环境（基础）
    makeEnvironmentContextDescriptor(),
    makeEnvironmentProfileDescriptor(runtime),

    // L1+: 环境主动扫描（新增）
    makeEnvironmentScanDescriptor(runtime),
    makeEnvironmentScanEnvvarsDescriptor(),
    makeEnvironmentDetectServicesDescriptor(),
    makeEnvironmentLearnFromFsDescriptor(runtime),
    makeEnvironmentWebSearchDescriptor(runtime),

    // Lh: Harness 同步（OpenClaw 对接）
    makeHarnessDetectDescriptor(runtime),
    makeHarnessSyncFromDescriptor(runtime),
    makeHarnessPushToDescriptor(runtime),
    makeHarnessStatusDescriptor(runtime),

    // Lc: 连接管理
    makeConnectDetectDescriptor(runtime),
    makeConnectRecommendDescriptor(runtime),
    makeConnectStatusDescriptor(runtime),
    makeConnectApplyDescriptor(runtime),

    // L2: 记忆
    makeKbSearchDescriptor(runtime),
    makeKbIngestDescriptor(runtime),
    makeKbStatusDescriptor(runtime),

    // L3: 感知理解
    makePerceiveMessageDescriptor(runtime),
    makePerceiveEntityDescriptor(runtime),
    makePerceiveIntentDescriptor(runtime),
    makePerceiveClassifyDescriptor(runtime),
    // L3+: 感知增强（类人交互）
    makePerceiveNeedsClarificationDescriptor(runtime),
    makePerceiveSentimentDescriptor(runtime),
    makePerceiveUserProfileUpdateDescriptor(runtime),

    // L4: 任务执行
    makeTaskRunDescriptor(runtime),
    makeTaskStatusDescriptor(runtime),

    // L5: 实体操作
    makeObjectCreateDescriptor(runtime),
    makeObjectQueryDescriptor(runtime),
    makeObjectUpdateDescriptor(runtime),
    makeObjectListTypesDescriptor(runtime),

    // L6: 事件
    makeEventPublishDescriptor(runtime),

    // Lx: 时间感知
    makeTimeNowDescriptor(),
    makeTimeShiftDescriptor(),
    makeTimeParsDescriptor(runtime),
    makeTimeDiffDescriptor(),

    // L7: 主动学习
    makeLearnObserveDescriptor(runtime),
    makeLearnFromFeedbackDescriptor(runtime),

    // L8: 自我进化（完整进化循环）
    makeEvolveDiscoverDescriptor(runtime),
    makeEvolveWritePlaybookDescriptor(runtime), // 向下兼容旧接口
    makeEvolveProposDescriptor(runtime),
    makeEvolveDeployDescriptor(runtime),
    makeEvolveVerifyDescriptor(runtime),
    makeEvolveLearnDescriptor(runtime),
    makeEvolveListDescriptor(runtime),
    makeEvolveRemoveDescriptor(runtime),
    makeEvolveFullCycleDescriptor(runtime),

    // L9: 兜底（任何消息都能处理）
    makeMessageHandleDescriptor(runtime),

    // Lx: Prompt 模板脚手架
    makePromptListDescriptor(runtime),
    makePromptRenderDescriptor(runtime),

    // Lx: LLM 增强（弱模型补偿）
    makeLlmStructuredCompleteDescriptor(runtime),

    // Lx: KB 文档摄入（长文档自动分块）
    makeKbIngestDocumentDescriptor(runtime),

    // Lr: 机器人身份系统
    makeRobotWhoamiDescriptor(runtime),
    makeRobotIdentityDescriptor(runtime),
    makeRobotOwnerDescriptor(runtime),
    makeRobotRelationsDescriptor(runtime),
    makeRobotAddRelationDescriptor(runtime),
    makeRobotIntroduceDescriptor(runtime),

    // Lo: Ontology Bootstrap（本体自举：从 CSV/OpenAPI/自然语言生成 ObjectType）
    makeOntologyBootstrapFromCsvDescriptor(runtime),
    makeOntologyBootstrapFromOpenApiDescriptor(runtime),
    makeOntologyBootstrapFromDescriptionDescriptor(runtime),

    // Lrule: Rule Engine 运行时注册（将 DecisionTable 热加载到 RuleEngine）
    makeRuleEngineRegisterTableDescriptor(runtime),
  ];

  registry.registerAll(descriptors);

  // Ls: Swarm 群协作能力（需要 runtime.config.a2a 确认）
  const swarm = createRobotSwarm(runtime);
  for (const d of makeSwarmCapabilities(swarm)) {
    registry.register(d);
  }

  // system.describe 最后注册（需要 registry.list() 完整）
  registry.register(makeSystemDescribeDescriptor(registry));

  return registry;
}

// ── Lo: Ontology Bootstrap（本体自举）─────────────────────────────────────
// 将 CSV / OpenAPI / 自然语言描述转化为 ObjectTypeDefinition，
// 注册到 OntologyEngine 供后续 object.* capability 直接使用。
// 类型严格对齐 ontology-types.ts：FieldDefinition.type 只能是
//   "string" | "number" | "boolean" | "date" | "enum" | "ref"
// FsmDefinition.transitions[].event 为事件名字符串（非 on/action 等别称）

const VALID_FIELD_TYPES = new Set<string>(["string", "number", "boolean", "date", "enum", "ref"]);

function normalizeFieldType(raw: string): FieldDefinition["type"] {
  const t = raw.toLowerCase();
  if (t === "integer" || t === "int" || t === "float" || t === "double") return "number";
  if (t === "bool") return "boolean";
  if (t === "datetime" || t === "timestamp") return "date";
  if (VALID_FIELD_TYPES.has(t)) return t as FieldDefinition["type"];
  return "string";
}

function makeOntologyBootstrapFromCsvDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "ontology.bootstrap_from_csv",
    verb: "create",
    description: "解析 CSV 文本（首行为字段名）自动推断并注册 ObjectType 本体定义",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["csv_text", "type_name"],
      properties: {
        csv_text: { type: "string", description: "包含表头行的 CSV 文本" },
        type_name: { type: "string", description: "生成的 ObjectType 名称" },
        pack: { type: "string", description: "归属 Pack（默认 'runtime'）" },
        description: { type: "string" },
      },
    },
    handler: async (_ctx, params) => {
      const csvText = String(params.csv_text ?? "");
      const typeName = String(params.type_name ?? "").trim();
      if (!typeName || !csvText) return { status: "error", reason: "type_name / csv_text 必填" };

      const lines = csvText.trim().split(/\r?\n/);
      if (lines.length < 2) return { status: "error", reason: "CSV 至少需要表头行 + 1 行数据" };

      const headers = lines[0]!.split(",").map((h) => h.trim());
      const sample = lines[1]!.split(",").map((v) => v.trim());

      const fields: FieldDefinition[] = headers.map((name, i) => {
        const val = sample[i] ?? "";
        let type: FieldDefinition["type"] = "string";
        if (!Number.isNaN(Number(val)) && val !== "") type = "number";
        else if (val.toLowerCase() === "true" || val.toLowerCase() === "false") type = "boolean";
        return { name, type, required: false };
      });

      const def: ObjectTypeDefinition = {
        name: typeName,
        description: String(params.description ?? `由 CSV 自举生成：${typeName}`),
        pack: String(params.pack ?? "runtime"),
        primaryKey: fields[0]?.name ?? "id",
        fields,
        actions: [],
      };

      if (!runtime.ontology?.registerType) {
        return { status: "error", reason: "OntologyEngine 未初始化" };
      }
      runtime.ontology.registerType(def);
      return { status: "ok", type_name: typeName, fields: fields.length };
    },
  };
}

function makeOntologyBootstrapFromOpenApiDescriptor(
  runtime: ClaworksRuntime,
): CapabilityDescriptor {
  return {
    id: "ontology.bootstrap_from_openapi",
    verb: "create",
    description: "解析 OpenAPI JSON/YAML 片段（schemas 段）批量注册 ObjectType 本体定义",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["openapi_json"],
      properties: {
        openapi_json: {
          type: "string",
          description: "OpenAPI JSON 字符串（包含 components.schemas）",
        },
        pack: { type: "string", description: "归属 Pack（默认 'runtime'）" },
        only_names: {
          type: "array",
          items: { type: "string" },
          description: "仅导入指定 schema 名（留空导入全部）",
        },
      },
    },
    handler: async (_ctx, params) => {
      const raw = String(params.openapi_json ?? "");
      const packName = String(params.pack ?? "runtime");
      const only = Array.isArray(params.only_names) ? (params.only_names as string[]) : [];

      if (!runtime.ontology?.registerType) {
        return { status: "error", reason: "OntologyEngine 未初始化" };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { status: "error", reason: "无法解析 OpenAPI JSON" };
      }

      const schemasRaw =
        ((parsed?.components as Record<string, unknown>)?.schemas as Record<string, unknown>) ??
        (parsed?.definitions as Record<string, unknown>) ??
        {};

      const registered: string[] = [];
      for (const [schemaName, schemaDef] of Object.entries(schemasRaw)) {
        if (only.length > 0 && !only.includes(schemaName)) continue;
        const schema = schemaDef as Record<string, unknown>;
        const propsRaw = (schema.properties as Record<string, Record<string, string>>) ?? {};
        const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

        const fields: FieldDefinition[] = Object.entries(propsRaw).map(([fieldName, fieldDef]) => {
          const rawType = String((fieldDef.type ?? fieldDef["$ref"]) ? "ref" : "string");
          const type = normalizeFieldType(rawType);
          return {
            name: fieldName,
            type,
            required: required.includes(fieldName),
            ...(fieldDef.enum
              ? { enumValues: fieldDef.enum as string[], type: "enum" as const }
              : {}),
          };
        });

        const def: ObjectTypeDefinition = {
          name: schemaName,
          description: String(schema.description ?? `由 OpenAPI 导入：${schemaName}`),
          pack: packName,
          primaryKey: required[0] ?? fields[0]?.name ?? "id",
          fields,
          actions: [],
        };
        runtime.ontology.registerType(def);
        registered.push(schemaName);
      }

      return { status: "ok", registered_count: registered.length, types: registered };
    },
  };
}

function makeOntologyBootstrapFromDescriptionDescriptor(
  runtime: ClaworksRuntime,
): CapabilityDescriptor {
  return {
    id: "ontology.bootstrap_from_description",
    verb: "create",
    description: "通过自然语言描述（借助 LLM）生成并注册 ObjectType 本体定义",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: {
          type: "string",
          description:
            "自然语言描述业务对象，例如：「设备工单，包含编号、设备ID、故障类型、状态（pending/open/closed）、优先级（1-5）」",
        },
        type_name: { type: "string", description: "ObjectType 名称（LLM 可推断）" },
        pack: { type: "string", description: "归属 Pack（默认 'runtime'）" },
      },
    },
    handler: async (_ctx, params) => {
      const description = String(params.description ?? "");
      const packName = String(params.pack ?? "runtime");
      if (!description) return { status: "error", reason: "description 不能为空" };

      if (!runtime.ontology?.registerType) {
        return { status: "error", reason: "OntologyEngine 未初始化" };
      }

      const llmFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
      if (!llmFn) return { status: "error", reason: "LLM 未配置，无法从描述生成本体" };

      const schema = {
        type: "object" as const,
        required: ["type_name", "fields"],
        properties: {
          type_name: { type: "string" as const },
          description: { type: "string" as const },
          primary_key: { type: "string" as const },
          fields: {
            type: "array" as const,
            items: {
              type: "object" as const,
              required: ["name", "type"],
              properties: {
                name: { type: "string" as const },
                type: { type: "string" as const },
                required: { type: "boolean" as const },
                enum_values: { type: "array" as const, items: { type: "string" as const } },
              },
            },
          },
          fsm: {
            type: "object" as const,
            properties: {
              field: { type: "string" as const },
              initial: { type: "string" as const },
              states: { type: "array" as const, items: { type: "string" as const } },
              transitions: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  properties: {
                    from: { type: "string" as const },
                    event: { type: "string" as const },
                    to: { type: "string" as const },
                  },
                },
              },
            },
          },
        },
      };

      const prompt = `根据以下业务对象描述，生成标准 ObjectType 定义（JSON）：

描述：${description}

要求：
- fields[].type 只能是：string | number | boolean | date | enum | ref
- 如有状态字段，生成 fsm.transitions，每条 transition 必须有 event 字段（表示触发事件名，如 "submit" "approve"）
- 输出纯 JSON，不要 markdown 代码块`;

      try {
        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const result = await llmFn({ prompt });
        const data = tryParseJson(result.text) as Record<string, unknown> | null;
        if (!data || typeof data.type_name !== "string") {
          return { status: "error", reason: "LLM 未返回合法 JSON", raw: result.text.slice(0, 200) };
        }

        const typeName = String(params.type_name ?? data.type_name ?? "Unknown");
        const rawFields = Array.isArray(data.fields)
          ? (data.fields as Record<string, unknown>[])
          : [];

        const fields: FieldDefinition[] = rawFields.map((f) => {
          const type = normalizeFieldType(String(f.type ?? "string"));
          const fd: FieldDefinition = {
            name: String(f.name ?? "field"),
            type,
            required: Boolean(f.required),
          };
          if (type === "enum" && Array.isArray(f.enum_values)) {
            fd.enumValues = f.enum_values as string[];
          }
          return fd;
        });

        let fsm: FsmDefinition | undefined;
        if (data.fsm && typeof data.fsm === "object") {
          const rawFsm = data.fsm as Record<string, unknown>;
          const transitions = Array.isArray(rawFsm.transitions)
            ? (rawFsm.transitions as Record<string, unknown>[]).map((t) => ({
                from: String(t.from ?? "*"),
                event: String(t.event ?? t.action ?? t.on ?? "change"),
                to: String(t.to ?? ""),
              }))
            : [];
          fsm = {
            field: String(rawFsm.field ?? "status"),
            initial: String(rawFsm.initial ?? ""),
            states: Array.isArray(rawFsm.states) ? (rawFsm.states as string[]) : [],
            transitions,
          };
        }

        const def: ObjectTypeDefinition = {
          name: typeName,
          description: String(data.description ?? description.slice(0, 120)),
          pack: packName,
          primaryKey: String(data.primary_key ?? fields[0]?.name ?? "id"),
          fields,
          actions: [],
          fsm,
        };

        runtime.ontology.registerType(def);
        return { status: "ok", type_name: typeName, fields: fields.length, has_fsm: !!fsm };
      } catch (e) {
        return { status: "error", reason: String(e) };
      }
    },
  };
}

// ── Lrule: Rule Engine 运行时注册──────────────────────────────────────────
function makeRuleEngineRegisterTableDescriptor(runtime: ClaworksRuntime): CapabilityDescriptor {
  return {
    id: "rule_engine.register_table",
    verb: "create",
    description:
      "将决策表 JSON 热加载到 RuleEngine（可由 sop_to_rules Playbook 或 Playbook 步骤调用）",
    owner: { kind: "core" },
    paramsSchema: {
      type: "object",
      required: ["table"],
      properties: {
        table: {
          type: "object",
          description:
            "DecisionTable JSON，包含 id/name/rules[]（条件+动作）。条件 op 支持 eq/neq/gt/gte/lt/lte/contains/regex。",
        },
      },
    },
    handler: async (_ctx, params) => {
      const table = params.table as DecisionTable | null;
      if (!table || typeof table !== "object" || !table.id) {
        return { status: "error", reason: "table 参数无效，必须包含 id 字段" };
      }
      if (!runtime.ruleEngine) {
        return { status: "error", reason: "RuleEngine 未初始化" };
      }
      if (typeof runtime.ruleEngine.registerTable !== "function") {
        return { status: "error", reason: "RuleEngine 版本不支持 registerTable" };
      }
      runtime.ruleEngine.registerTable(table as Record<string, unknown>);
      return {
        status: "ok",
        table_id: table.id,
        rules_count: Array.isArray(table.rules) ? table.rules.length : 0,
      };
    },
  };
}
