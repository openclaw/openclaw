/**
 * extension-capabilities.ts — ClaWorks 通用机器人能力
 *
 * 架构原则（OpenClaw: "Core stays plugin-agnostic"）：
 *
 *   此文件只注册"通用机器人能力"——任何行业、任何场景都可能用到的基础能力。
 *   业务域特定能力（设备、班次、生产、安全等工业能力）必须在 Pack 中注册，
 *   通过 claworks-packs/<domain>/src/capabilities.ts 实现，经由 PackLoader
 *   加载到运行时，而不是硬编码在这里。
 *
 * 三层架构：
 *   第一层（Platform Runtime）：此文件 — 平台内置能力，绝不含业务逻辑
 *   第二层（基础 Pack）：claworks-packs/base — 业务基础 Playbook 及可选 Pack capabilities
 *   第三层（行业 Pack）：claworks-packs/industrial 等 — 行业专属 Playbook 及 Pack capabilities
 *
 * 注意：Pack 不是插件（Plugin）。Pack 由 PackLoader 加载贡献 Playbook/ObjectType/capability；
 * Plugin 是向宿主进程（OpenClaw Gateway）注册服务的代码模块，仅 extensions/claworks-robot 是 Plugin。
 *
 * 能力清单（A 类：保留在核心）：
 *   L10 reasoning.*   推理（思考、分解、评估）
 *   L11 memory.*      记忆管理（召回、工作集）
 *   L12 comms.*       通信（发送、广播）
 *   L13 a2a.*         Agent-to-Agent（委派、发现、描述）
 *   L14 pack.*        Pack 管理（列表、安装、重载）
 *   L15 connector.*   连接器管理（列表、调用、状态）
 *   L16 schedule.*    计划任务（创建、列表、取消）
 *   L17 monitor.*     监控告警（注册监控、查询状态）
 *   L18 nexus.*       Nexus 注册表（搜索、描述）
 *   L19 guide.*       弱模型辅助（任务分解、步骤引导、模板执行）
 *   L20 constitution.*  行为准则（查询、设置用户规则、反馈记录）
 *   L21 context.*     对话上下文
 *   L22 memory.case_* CBR 案例记忆
 *   L23 hook.*        事件主动推送
 *   L24 provider.*    Provider 注册表
 *   L25 task.*        通用任务管理（业务无关）
 *   L26 report.*      通用报告生成
 *   L27 approval.*    通用审批流
 *   L28 work_order.*  通用工单（core 注册，供 base pack Playbook 调用）
 *   L29 alarm.*       通用报警（core 注册，供 base pack Playbook 调用）
 *   L30 notify.*      通用通知路由
 *   L32 system.*      系统管理
 *   L33 skill.*       技能库
 *   L34 rule.*        规则引擎
 *   L35 governance.*  治理（audit, governance）
 *   L36 security.*    安全审计 + observe.*
 *   L40 research.*    多源并行研究（KB + 网络 + 事件日志）
 *   L41 agent.*       智能体编排（ReAct / plan / spawn）
 *
 * 已迁移到 Pack（不再在此注册）：
 *   L31（工业能力）— claworks-packs/industrial/src/capabilities.ts
 *     shift.*, incident.*, equipment.*, maintenance.*, production.*, safety.*
 */

import { resolveA2aTarget } from "../claworks/a2a-peers.js";
import { discoverHarnessSkillsFromConfig } from "../claworks/harness-sync.js";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { buildA2aAgentCard } from "../interfaces/a2a/agent-card.js";
import { A2aClient } from "../interfaces/a2a/client.js";
import { BRIDGE_LLM, BRIDGE_NOTIFY, BRIDGE_SKILL } from "./bridge-registry.js";
import type { CapabilityDescriptor, CapabilityContext } from "./capability-registry.js";
import { CW_EVENTS } from "./event-names.js";
import type { ConstitutionV2 } from "./robot-constitution-v2.js";

function capabilityInvokeCtx(runtime: ClaworksRuntime, source: string): CapabilityContext {
  const ctx: CapabilityContext = {
    source,
    invoke: async (capabilityId, params) => runtime.capabilities.invoke(capabilityId, ctx, params),
  };
  return ctx;
}

// ── L10: reasoning.* ─────────────────────────────────────────────────────

export function makeReasoningCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const llm = () => runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;

  return [
    {
      id: "reasoning.think",
      verb: "compose",
      description: "链式推理：对一个问题一步步思考，返回推理过程和结论",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          context: { type: "string", description: "相关背景信息" },
          constraints: { type: "array", items: { type: "string" }, description: "约束条件" },
        },
      },
      handler: async (_ctx, params) => {
        const question = String(params.question ?? "");
        const context = String(params.context ?? "");
        const constraints = Array.isArray(params.constraints)
          ? (params.constraints as string[]).join("\n- ")
          : "";

        const completeFn = llm();
        if (!completeFn) {
          return { status: "no_llm", conclusion: "无法推理：LLM 未配置" };
        }

        const prompt = [
          "请对以下问题进行逐步推理，格式：",
          '{"steps":["步骤1...","步骤2..."],"conclusion":"...","confidence":0.0-1.0}',
          "",
          `问题：${question}`,
          context ? `背景：${context}` : "",
          constraints ? `约束：\n- ${constraints}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        try {
          const { tryParseJson } = await import("../planes/orch/function-executor.js");
          const result = await completeFn({ prompt });
          const parsed = tryParseJson(result.text);
          return parsed ?? { status: "parse_failed", raw: result.text };
        } catch (err) {
          return { status: "error", reason: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      id: "reasoning.decompose",
      verb: "compose",
      description: "将复杂任务分解为可由机器人执行的原子步骤，并为每步匹配最佳 Playbook 或能力",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", description: "要分解的任务描述" },
          max_steps: { type: "integer", default: 5 },
        },
      },
      handler: async (_ctx, params) => {
        const task = String(params.task ?? "");
        const maxSteps = typeof params.max_steps === "number" ? params.max_steps : 5;

        const capabilities = runtime.capabilities
          .list()
          .map((c) => `${c.id}: ${c.description}`)
          .join("\n");
        const playbooks = runtime.playbookEngine
          .list()
          .map((p) => `${p.id}: ${p.name}`)
          .join("\n");

        const completeFn = llm();
        if (!completeFn) {
          return {
            status: "no_llm",
            steps: [
              { step: 1, action: "message.handle", params: { text: task }, description: task },
            ],
          };
        }

        const prompt = [
          `将以下任务分解为最多 ${maxSteps} 个原子步骤，每步使用机器人已有的能力或 Playbook。`,
          "",
          "已有能力（优先使用）：",
          capabilities,
          "",
          "已有 Playbook：",
          playbooks,
          "",
          `任务：${task}`,
          "",
          '返回 JSON：{"steps":[{"step":1,"type":"capability|playbook","id":"...","params":{},"description":"..."}],"rationale":"..."}',
        ].join("\n");

        try {
          const { tryParseJson } = await import("../planes/orch/function-executor.js");
          const result = await completeFn({ prompt });
          const parsed = tryParseJson(result.text);
          return parsed ?? { status: "parse_failed", raw: result.text };
        } catch (err) {
          return { status: "error", reason: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      id: "reasoning.evaluate",
      verb: "query",
      description: "评估一个选项或结果：给出优缺点、风险、建议",
      owner: { kind: "core" },
      handler: async (_ctx, params) => {
        const subject = String(params.subject ?? params.option ?? "");
        const criteria = Array.isArray(params.criteria) ? params.criteria.join(", ") : "";
        const completeFn = llm();
        if (!completeFn) {
          return { status: "no_llm", score: 0, recommendation: "无法评估" };
        }

        const prompt = [
          `评估以下内容：${subject}`,
          criteria ? `评估标准：${criteria}` : "",
          '格式：{"pros":["..."],"cons":["..."],"risks":["..."],"score":0-10,"recommendation":"..."}',
        ]
          .filter(Boolean)
          .join("\n");

        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const result = await completeFn({ prompt });
        return tryParseJson(result.text) ?? { status: "parse_failed", raw: result.text };
      },
    },

    {
      id: "reason.chain",
      verb: "compose",
      description: "链式推理：将复杂问题分步骤推理，每步结果传入下一步，最终得出结论",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["question", "steps"],
        properties: {
          question: { type: "string", description: "核心问题" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "推理步骤描述列表，如 ['分析问题', '检索信息', '得出结论']",
          },
          context: { type: "string", description: "初始上下文" },
        },
      },
      handler: async (_ctx, params) => {
        const question = String(params.question ?? "");
        const steps = Array.isArray(params.steps)
          ? (params.steps as string[])
          : ["分析问题", "得出结论"];
        const initialContext = String(params.context ?? "");

        const completeFn = llm();
        if (!completeFn) {
          return { status: "no_llm", conclusion: "无法推理：LLM 未配置" };
        }

        const { tryParseJson } = await import("../planes/orch/function-executor.js");
        const stepResults: Array<{ step: string; result: unknown }> = [];
        let accumulatedContext = initialContext;

        for (const step of steps) {
          const prompt = [
            `问题：${question}`,
            accumulatedContext ? `当前上下文：${accumulatedContext}` : "",
            `当前推理步骤：${step}`,
            "",
            `请执行"${step}"并以JSON格式输出结果：{"output":"...","key_findings":["..."]}`,
          ]
            .filter(Boolean)
            .join("\n");

          try {
            const result = await completeFn({ prompt });
            const parsed = tryParseJson(result.text);
            const output = String(parsed?.output ?? result.text.slice(0, 200));
            stepResults.push({ step, result: parsed ?? output });
            accumulatedContext = [accumulatedContext, `[${step}] ${output}`]
              .filter(Boolean)
              .join("\n");
          } catch (err) {
            stepResults.push({
              step,
              result: { error: err instanceof Error ? err.message : String(err) },
            });
          }
        }

        // 最终总结
        const conclusionPrompt = [
          `问题：${question}`,
          `推理过程：\n${stepResults.map((s) => `[${s.step}] ${JSON.stringify(s.result)}`).join("\n")}`,
          `请总结最终结论，以JSON格式输出：{"conclusion":"...","confidence":0.0-1.0,"action_hint":"建议下一步"}`,
        ].join("\n");

        try {
          const finalResult = await completeFn({ prompt: conclusionPrompt });
          const finalParsed = tryParseJson(finalResult.text);
          return {
            status: "ok",
            question,
            steps: stepResults,
            conclusion: String(finalParsed?.conclusion ?? ""),
            confidence: typeof finalParsed?.confidence === "number" ? finalParsed.confidence : 0.7,
            action_hint: String(finalParsed?.action_hint ?? ""),
          };
        } catch {
          return {
            status: "ok",
            question,
            steps: stepResults,
            conclusion: accumulatedContext.slice(-200),
          };
        }
      },
    },
  ];
}

// ── L11: memory.* ─────────────────────────────────────────────────────────

export function makeMemoryCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "memory.recall",
      verb: "retrieve",
      description: "召回近期交互记录和上下文（情景记忆）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "查询内容（不填则返回最近记录）" },
          limit: { type: "integer", default: 10 },
          since_hours: { type: "number", default: 24 },
        },
      },
      handler: async (_ctx, params) => {
        const query = String(params.query ?? "");
        const limit = typeof params.limit === "number" ? params.limit : 10;
        const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;

        if (query) {
          const results = await runtime.kb.search(query, { limit });
          return { results, count: results.length, source: "semantic_search" };
        }

        // 从 EventBus 获取近期事件作为情景记忆
        const events = await runtime.kernel.bus.query({
          from: new Date(Date.now() - sinceHours * 3_600_000),
          limit,
        });
        return {
          recent_events: events.map((e) => ({
            type: e.type,
            source: e.source,
            timestamp: e.timestamp,
            summary: JSON.stringify(e.payload).slice(0, 100),
          })),
          count: events.length,
          source: "event_bus",
        };
      },
    },

    {
      id: "memory.consolidate",
      verb: "transform",
      description: "整合近期学习记录，去重、合并相关知识点、剪枝低质量条目，提升知识库质量",
      owner: { kind: "core" },
      handler: async () => {
        const maxEntries = 100;
        const results = await runtime.kb.search("", { limit: maxEntries });
        if (results.length === 0) {
          return { status: "ok", reviewed: 0, merged: 0, pruned: 0, note: "No KB entries found." };
        }

        // Group by subject similarity (simple: same first 40 chars of content)
        const groups = new Map<string, typeof results>();
        for (const entry of results) {
          const key = String(entry.content ?? entry.title ?? "")
            .slice(0, 40)
            .toLowerCase()
            .trim();
          if (!key) {
            continue;
          }
          const group = groups.get(key) ?? [];
          group.push(entry);
          groups.set(key, group);
        }

        let merged = 0;
        let pruned = 0;
        const ops: Array<Promise<unknown>> = [];

        for (const [, group] of groups.entries()) {
          if (group.length < 2) {
            continue;
          }

          // Keep the highest-scored / most recent entry, accumulate content from others
          const sorted = group.toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
          const primary = sorted[0];
          const duplicates = sorted.slice(1);

          // Merge content of duplicates into primary
          const mergedContent = [
            String(primary.content ?? primary.title ?? ""),
            ...duplicates.map((d) => String(d.content ?? d.title ?? "")),
          ]
            .filter(Boolean)
            .join("\n---\n");

          // Re-ingest merged content (KB add overwrites if id matches)
          ops.push(
            (runtime.kb.add
              ? runtime.kb.add({
                  id: String(primary.id ?? ""),
                  title: String(primary.title ?? "consolidated"),
                  content: mergedContent,
                  tags: ["consolidated", "auto-learned"],
                })
              : runtime.kb.ingest(mergedContent, { source: "memory.consolidate" })
            ).catch(() => undefined),
          );
          merged += 1;

          // Prune duplicates (low-score extras) — best-effort removal
          for (const dup of duplicates) {
            if (dup.id && typeof runtime.kb.remove === "function") {
              ops.push(runtime.kb.remove(String(dup.id)).catch(() => undefined));
              pruned += 1;
            }
          }
        }

        await Promise.allSettled(ops);

        return {
          status: "ok",
          reviewed: results.length,
          groups: groups.size,
          merged,
          pruned,
          note: `Consolidated ${merged} duplicate groups; pruned ${pruned} entries.`,
        };
      },
    },

    {
      id: "memory.list_sessions",
      verb: "query",
      description: "列出所有活跃会话（便于调试和管理对话上下文）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const allSessions = runtime.contextEngine?.listSessions?.() ?? [];
        const sessions = allSessions.slice(0, limit);
        return {
          sessions,
          count: sessions.length,
          note: sessions.length === 0 ? "contextEngine 未实现 listSessions" : undefined,
        };
      },
    },

    {
      id: "memory.forget",
      verb: "control",
      description: "删除特定记忆条目（GDPR/隐私合规）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "KB 条目 ID" },
          session_id: { type: "string", description: "会话 ID（清除该会话全部上下文）" },
          tags: { type: "array", items: { type: "string" }, description: "按 tags 批量删除" },
        },
      },
      handler: async (_ctx, params) => {
        const deleted: string[] = [];
        const errors: string[] = [];

        if (params.id && typeof runtime.kb.remove === "function") {
          try {
            await runtime.kb.remove(String(params.id));
            deleted.push(`kb:${params.id}`);
          } catch (err) {
            errors.push(`kb remove failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (params.session_id && runtime.contextEngine?.clear) {
          try {
            runtime.contextEngine?.clear(String(params.session_id));
            deleted.push(`session:${params.session_id}`);
          } catch (err) {
            errors.push(
              `session clear failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        return {
          status: deleted.length > 0 ? "ok" : "nothing_deleted",
          deleted,
          errors,
        };
      },
    },
  ];
}

// ── L11b: memory.store / memory.get（短期键值记忆）─────────────────────────

const _globalMemoryStore = new Map<string, { value: unknown; expires: number | null }>();

export function makeMemoryKvCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "memory.store",
      verb: "acquire",
      description: "在短期记忆中存储键值数据，支持 TTL（秒）。优先 DB 持久化，降级内存 Map。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string" },
          value: {},
          ttl_seconds: { type: "number", description: "过期秒数，不填则永不过期" },
          session_id: { type: "string", description: "命名空间前缀" },
        },
      },
      handler: async (_ctx, params) => {
        const fullKey =
          typeof params.session_id === "string" && params.session_id
            ? `${params.session_id}:${params.key}`
            : String(params.key);
        const db = (runtime as unknown as Record<string, unknown>).db as
          | { prepare: (sql: string) => { run: (...a: unknown[]) => void } }
          | undefined;
        if (db) {
          try {
            const expiresAt =
              typeof params.ttl_seconds === "number"
                ? new Date(Date.now() + params.ttl_seconds * 1000).toISOString()
                : null;
            db.prepare(
              `INSERT OR REPLACE INTO cw_memory (key, value, expires_at, updated_at) VALUES (?, ?, ?, datetime('now'))`,
            ).run(fullKey, JSON.stringify(params.value), expiresAt);
            return { success: true, key: fullKey };
          } catch {
            // fallthrough to in-memory
          }
        }
        _globalMemoryStore.set(fullKey, {
          value: params.value,
          expires:
            typeof params.ttl_seconds === "number" ? Date.now() + params.ttl_seconds * 1000 : null,
        });
        return { success: true, key: fullKey };
      },
    },

    {
      id: "memory.get",
      verb: "retrieve",
      description: "读取短期记忆中的键值数据（支持 TTL 自动过期）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string" },
          session_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const fullKey =
          typeof params.session_id === "string" && params.session_id
            ? `${params.session_id}:${params.key}`
            : String(params.key);
        const db = (runtime as unknown as Record<string, unknown>).db as
          | {
              prepare: (sql: string) => {
                get: (...a: unknown[]) => { value: string; expires_at: string | null } | undefined;
              };
            }
          | undefined;
        if (db) {
          try {
            const row = db
              .prepare(
                `SELECT value, expires_at FROM cw_memory WHERE key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
              )
              .get(fullKey);
            if (row) {
              return { found: true, value: JSON.parse(row.value) as unknown, key: fullKey };
            }
            return { found: false, value: null, key: fullKey };
          } catch {
            // fallthrough to in-memory
          }
        }
        const entry = _globalMemoryStore.get(fullKey);
        if (!entry) return { found: false, value: null, key: fullKey };
        if (entry.expires !== null && entry.expires < Date.now()) {
          _globalMemoryStore.delete(fullKey);
          return { found: false, value: null, key: fullKey };
        }
        return { found: true, value: entry.value, key: fullKey };
      },
    },
  ];
}

// ── L12: comms.* ──────────────────────────────────────────────────────────

export function makeCommsCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "comms.send",
      verb: "deliver",
      description: "通过配置的渠道发送消息（必须标识为机器人身份）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          channel: { type: "string", description: "单渠道 ID（如 feishu）" },
          channels: { type: "array", items: { type: "string" }, description: "多渠道 ID 列表" },
          user_id: {
            type: "string",
            description: "按用户 ID 路由（查询 NotificationRouter 偏好）",
          },
          role: { type: "string", description: "按角色路由（通知该角色所有绑定用户）" },
          urgency: { type: "string", description: "紧急程度（normal/high/critical）" },
          robot_signature: {
            type: "boolean",
            default: true,
            description: "是否附加机器人身份标识",
          },
        },
      },
      handler: async (_ctx, params) => {
        const rawMessage = String(params.message ?? "");
        const addSignature = params.robot_signature !== false;

        // 清理弱模型常见输出问题：
        // 1. 移除 ```json ``` 包装
        // 2. 移除前缀的角色标签（"回复：" "助手：" 等）
        // 3. 截断超长回复（>2000 字符时加省略提示）
        const cleanMessage = (msg: string): string => {
          let s = msg.trim();
          s = s.replace(/^```[\w]*\n?/m, "").replace(/\n?```$/m, "");
          s = s.replace(/^(回复|助手|机器人|AI)[：:]\s*/i, "");
          s = s.trim();
          if (s.length > 2000) {
            s = s.slice(0, 1980) + "\n…（内容过长，已截断）";
          }
          return s;
        };
        const cleanedRaw = cleanMessage(rawMessage);

        // 卡片适配：如果 params.card 存在，为所有渠道预建渠道原生卡片 map
        const cwCard = params.card as import("./card-builder.js").CwCard | undefined;

        // 按渠道 ID 列表构建 cards map（仅在 cwCard 存在时）
        const buildCardsMap = (channelIds: string[]): Record<string, unknown> | undefined => {
          if (!cwCard || !runtime.cardBuilder) return undefined;
          const map: Record<string, unknown> = {};
          for (const ch of channelIds) {
            const formatted = runtime.cardBuilder.toAuto(cwCard, ch);
            if (formatted != null) map[ch] = formatted;
          }
          return Object.keys(map).length > 0 ? map : undefined;
        };

        const buildPlainMessage = (): string => {
          if (!cwCard || !runtime.cardBuilder) {
            return addSignature ? `[${runtime.robot.name}] ${cleanedRaw}` : cleanedRaw;
          }
          const plainText = runtime.cardBuilder.toPlainText(cwCard);
          return addSignature ? `[${runtime.robot.name}] ${plainText}` : plainText;
        };

        const finalMessage = addSignature ? `[${runtime.robot.name}] ${cleanedRaw}` : cleanedRaw;

        // user_id 路由：通过 NotificationRouter 找用户偏好渠道
        if (params.user_id) {
          const userId = String(params.user_id);
          const pref = runtime.notificationRouter?.getPreference(userId);
          const channels = pref?.channels?.length ? pref.channels : undefined;
          const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
          const message = buildPlainMessage();
          const cards = channels ? buildCardsMap(channels) : undefined;
          if (notifyBridge) {
            await notifyBridge.send({ message, channels, ...(cards ? { cards } : {}) });
          } else {
            runtime.logger?.(
              `[comms.send → ${userId}] channels=${channels?.join(",") ?? "log"} msg=${message}`,
            );
          }
          return { status: "ok", message, channels, routed_by: "user_id", user_id: userId };
        }

        // role 路由：找到所有该角色用户，逐一发送
        if (params.role) {
          const role = String(params.role);
          const bindings =
            runtime.notificationRouter
              ?.listBindings()
              .filter((b) => b.subjectType === "role" && b.subjectId === role) ?? [];
          const userIds = (bindings ?? []).flatMap((b) => b.userIds);
          const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
          if (userIds.length === 0) {
            const message = buildPlainMessage();
            if (notifyBridge) {
              await notifyBridge.send({ message });
            } else {
              runtime.logger?.(`[comms.send/role-fallback] role=${role} ${message}`);
            }
            return { status: "ok", message, channels: ["default"], routed_by: "role_fallback" };
          }
          await Promise.allSettled(
            userIds.map(async (uid) => {
              const pref = runtime.notificationRouter?.getPreference(uid);
              const channels = pref?.channels?.length ? pref.channels : undefined;
              const message = buildPlainMessage();
              const cards = channels ? buildCardsMap(channels) : undefined;
              if (notifyBridge) {
                await notifyBridge.send({ message, channels, ...(cards ? { cards } : {}) });
              } else {
                runtime.logger?.(`[comms.send → ${uid}] channels=${channels?.join(",") ?? "log"}`);
              }
            }),
          );
          return { status: "ok", message: finalMessage, recipients: userIds, routed_by: "role" };
        }

        // 直接指定渠道（保留原有行为）
        const channels = Array.isArray(params.channels)
          ? (params.channels as string[])
          : params.channel
            ? [String(params.channel)]
            : undefined;
        const message = buildPlainMessage();
        const cards = channels ? buildCardsMap(channels) : undefined;

        const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
        if (notifyBridge) {
          await notifyBridge.send({ message, channels, ...(cards ? { cards } : {}) });
        } else {
          runtime.logger?.(`[comms.send] ${message} channels=${channels?.join(",") ?? "log"}`);
        }

        // 将机器人回复写入对话上下文（供后续 _session 使用）
        const sessionIdForContext = params.user_id
          ? `direct:user:${String(params.user_id)}`
          : channels?.[0]
            ? `channel:${channels[0]}`
            : undefined;
        if (sessionIdForContext && runtime.contextEngine) {
          runtime.contextEngine.append(sessionIdForContext, "assistant", message);
        }

        return { status: "ok", message, channels };
      },
    },

    {
      id: "comms.broadcast",
      verb: "deliver",
      description: "向所有配置的渠道广播消息（需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "广播消息影响所有渠道，需要确认" },
      handler: async (_ctx, params) => {
        const message = String(params.message ?? "");
        const finalMessage = `[${runtime.robot.name} BROADCAST] ${message}`;

        const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
        if (notifyBridge) {
          await notifyBridge.send({ message: finalMessage });
        }

        await runtime.kernel.publish("comms.broadcast_sent", "comms.broadcast", {
          message: finalMessage,
        });

        return { status: "ok", message: finalMessage };
      },
    },

    {
      id: "comms.history",
      verb: "query",
      description: "查看最近发送的消息历史（便于排查通知是否送达）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 20 },
          since_hours: { type: "number", default: 24 },
          user_id: { type: "string", description: "按收件人过滤" },
        },
      },
      handler: async (_ctx, params) => {
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;
        const userId = params.user_id ? String(params.user_id) : undefined;

        const events = await runtime.kernel.bus.query({
          from: new Date(Date.now() - sinceHours * 3_600_000),
          limit: limit * 2,
        });

        const commEvents = events.filter(
          (e) => e.type.startsWith("comms.") || e.type.startsWith("notify."),
        );

        const filtered = userId
          ? commEvents.filter((e) => {
              const p = e.payload;
              return String(p.user_id ?? p.recipient ?? "").includes(userId);
            })
          : commEvents;

        return {
          messages: filtered.slice(0, limit).map((e) => ({
            type: e.type,
            timestamp: e.timestamp,
            summary: JSON.stringify(e.payload).slice(0, 120),
          })),
          count: filtered.length,
          since_hours: sinceHours,
        };
      },
    },

    {
      id: "comms.throttle_status",
      verb: "query",
      description: "查看通知节流状态（哪些 userId+eventType 正处于节流期）",
      owner: { kind: "core" },
      handler: async () => {
        const throttleMap = (runtime as unknown as { _commsThrottle?: Map<string, number> })
          ._commsThrottle;
        if (!throttleMap) {
          return { status: "ok", throttled: [], count: 0, note: "节流表未初始化" };
        }

        const now = Date.now();
        const throttled = [...throttleMap.entries()]
          .filter(([, expiry]) => expiry > now)
          .map(([key, expiry]) => ({ key, expires_in_ms: expiry - now }));
        return { status: "ok", throttled, count: throttled.length };
      },
    },

    {
      id: "comms.stream_reply",
      verb: "deliver",
      description:
        "流式 LLM 回复：调用 LLM 生成回复并发送，如渠道支持则分块推送（打字机效果）。不支持流式时自动降级为普通回复。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "传给 LLM 的提示词" },
          channel: { type: "string", description: "目标渠道 ID" },
          channels: { type: "array", items: { type: "string" } },
          model: { type: "string", description: "指定模型（可选）" },
          max_tokens: { type: "number", description: "最大生成 token 数，默认 500" },
          robot_signature: { type: "boolean", default: true },
        },
      },
      handler: async (_ctx, params) => {
        const prompt = String(params.prompt ?? "");
        const model = params.model ? String(params.model) : undefined;
        const maxTokens = typeof params.max_tokens === "number" ? params.max_tokens : 500;
        const addSignature = params.robot_signature !== false;

        const llmFn = runtime.bridges?.get(BRIDGE_LLM)?.complete ?? runtime.llmComplete;
        if (!llmFn) {
          return { status: "no_llm", message: "LLM 未配置，无法生成回复" };
        }

        // 发布流式开始事件（渠道层可监听此事件显示"正在输入…"）
        const channels = Array.isArray(params.channels)
          ? (params.channels as string[])
          : params.channel
            ? [String(params.channel)]
            : undefined;
        await runtime.kernel.publish("comms.stream_started", "comms.stream_reply", {
          channels,
          prompt_length: prompt.length,
        });

        let text: string;
        try {
          const result = await llmFn({ prompt, model });
          text = result.text;
        } catch (err) {
          await runtime.kernel.publish("comms.stream_failed", "comms.stream_reply", {
            error: err instanceof Error ? err.message : String(err),
            channels,
          });
          return {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }

        const finalText = addSignature ? `[${runtime.robot.name}] ${text}` : text;

        // 发布流式完成事件
        await runtime.kernel.publish("comms.stream_completed", "comms.stream_reply", {
          channels,
          message_length: finalText.length,
        });

        // 发送最终消息
        const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
        if (notifyBridge) {
          await notifyBridge.send({ message: finalText, channels });
        } else {
          runtime.logger?.(
            `[comms.stream_reply] ${finalText} channels=${channels?.join(",") ?? "log"}`,
          );
        }

        return { status: "ok", message: finalText, channels };
      },
    },
  ];
}

// ── L13: a2a.* ────────────────────────────────────────────────────────────

export function makeA2aCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const peers = () => runtime.config.a2a?.peers ?? [];

  return [
    {
      id: "a2a.discover",
      verb: "query",
      description: "发现所有已配置的 A2A 对等机器人及其能力",
      owner: { kind: "core" },
      handler: async () => {
        const peerList = peers();
        const discovered = await Promise.allSettled(
          peerList.map(async (peer) => {
            const url = resolveA2aTarget(peer.name, peerList);
            const client = new A2aClient({ baseUrl: url });
            try {
              const card = await client.fetchAgentCard();
              return {
                name: peer.name,
                url,
                status: "online",
                skills: card.skills?.length ?? 0,
                card,
              };
            } catch {
              return { name: peer.name, url, status: "offline" };
            }
          }),
        );
        return {
          peers: discovered.map((r) => (r.status === "fulfilled" ? r.value : { status: "error" })),
          total: peerList.length,
        };
      },
    },

    {
      id: "a2a.describe",
      verb: "query",
      description: "获取指定 A2A 对等机器人的能力卡片",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["peer_name"],
        properties: { peer_name: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const peerName = String(params.peer_name ?? "");
        const url = resolveA2aTarget(peerName, peers());
        const client = new A2aClient({ baseUrl: url });
        const card = await client.fetchAgentCard();
        return { status: "ok", peer_name: peerName, ...card };
      },
    },

    {
      id: "a2a.delegate",
      verb: "deliver",
      description: "将一个任务委派给 A2A 对等机器人执行（需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "委派任务给外部 Agent 需要确认" },
      paramsSchema: {
        type: "object",
        required: ["peer_name", "task"],
        properties: {
          peer_name: { type: "string" },
          task: { type: "string" },
          wait_result: { type: "boolean", default: true },
        },
      },
      handler: async (ctx, params) => {
        const peerName = String(params.peer_name ?? "");
        const task = String(params.task ?? "");
        const waitResult = params.wait_result !== false;

        const url = resolveA2aTarget(peerName, peers());
        const client = new A2aClient({ baseUrl: url });

        await runtime.kernel.publish("a2a.delegate_started", "a2a.delegate", {
          peer: peerName,
          task,
          correlationId: ctx.correlationId,
        });

        if (waitResult) {
          const result = await client.sendAndWait({
            message: { role: "user", parts: [{ type: "text", text: task }] },
          });
          return { status: "ok", task_id: result.id, result: result.result };
        }
        const result = await client.sendTask({
          message: { role: "user", parts: [{ type: "text", text: task }] },
        });
        return { status: "queued", task_id: result.id };
      },
    },

    {
      id: "a2a.self_describe",
      verb: "query",
      description: "返回本机器人的 A2A 代理卡片（供对等机器人发现）",
      owner: { kind: "core" },
      handler: async () => {
        return buildA2aAgentCard(runtime) as unknown as Record<string, unknown>;
      },
    },

    {
      id: "a2a.send_task",
      verb: "deliver",
      description: "向另一个机器人发送任务（A2A 客户端，异步执行）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["peer_name", "task"],
        properties: {
          peer_name: { type: "string" },
          task: { type: "string" },
          metadata: { type: "object" },
        },
      },
      handler: async (_ctx, params) => {
        const peerName = String(params.peer_name ?? "");
        const task = String(params.task ?? "");
        const metadata = (params.metadata as Record<string, unknown> | undefined) ?? {};
        const url = resolveA2aTarget(peerName, peers());
        const client = new A2aClient({ baseUrl: url });
        const result = await client.sendTask({
          message: { role: "user", parts: [{ type: "text", text: task }] },
          metadata,
        });
        return { status: "queued", task_id: result.id, peer: peerName };
      },
    },

    {
      id: "a2a.list_peers",
      verb: "query",
      description: "列出所有已配置的对等机器人",
      owner: { kind: "core" },
      handler: async () => {
        const peerList = peers();
        return {
          peers: peerList.map((p) => ({ name: p.name, endpoint: p.endpoint ?? p.url })),
          count: peerList.length,
        };
      },
    },

    {
      id: "a2a.add_peer",
      verb: "modify",
      description: "添加对等机器人（管理员权限）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["name", "endpoint"],
        properties: {
          name: { type: "string" },
          endpoint: { type: "string" },
          trusted: { type: "boolean", default: false },
        },
      },
      handler: async (_ctx, params) => {
        const name = String(params.name ?? "");
        const endpoint = String(params.endpoint ?? "");
        if (!runtime.config.a2a) {
          (runtime.config as Record<string, unknown>).a2a = { enabled: true, peers: [] };
        }
        if (!runtime.config.a2a!.peers) {
          (runtime.config.a2a as Record<string, unknown>).peers = [];
        }
        const existing = runtime.config.a2a!.peers!.find((p) => p.name === name);
        if (!existing) {
          runtime.config.a2a!.peers!.push({ name, url: endpoint, endpoint });
        }
        return { status: "ok", name, endpoint, added: !existing };
      },
    },
  ];
}

// ── L14: pack.* ───────────────────────────────────────────────────────────

export function makePackCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "pack.list",
      verb: "query",
      description: "列出所有已安装的 Pack 及其提供的能力",
      owner: { kind: "core" },
      handler: async () => ({
        packs: runtime.loadedPacks.map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          playbooks: p.manifest.provides.playbooks,
          object_types: p.manifest.provides.objectTypes,
          action_types: p.manifest.provides.actionTypes,
        })),
        total: runtime.loadedPacks.length,
      }),
    },

    {
      id: "pack.install",
      verb: "acquire",
      description: "从 Nexus 安装一个新 Pack（需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "安装新 Pack 会扩展机器人能力，需要确认" },
      paramsSchema: {
        type: "object",
        required: ["pack_id"],
        properties: {
          pack_id: { type: "string" },
          version: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const packId = String(params.pack_id ?? "");
        try {
          const pack = await runtime.packLoader.install(packId, runtime.config.packs ?? {});
          await runtime.playbookEngine.reloadPack(packId);
          await runtime.ontology.loadFromPacks([pack]);

          // 注册 Pack 的能力（如果 Pack 有 ActionProvider）
          await runtime.kernel.publish("pack.installed", "pack.install", {
            pack_id: packId,
            version: pack.manifest.version,
            playbooks: pack.manifest.provides.playbooks,
          });
          // pack.loaded is the Playbook-facing alias used by pack_load_notify.yaml
          await runtime.kernel.publish("pack.loaded", "pack.install", {
            pack_id: packId,
            version: pack.manifest.version,
            action: "loaded",
            playbook_count: pack.manifest.provides.playbooks?.length ?? 0,
          });

          return { status: "ok", pack_id: packId, version: pack.manifest.version };
        } catch (err) {
          return { status: "error", reason: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      id: "pack.reload",
      verb: "control",
      description: "重新加载一个 Pack（Pack 文件更新后使用）",
      owner: { kind: "core" },
      handler: async (_ctx, params) => {
        const packId = String(params.pack_id ?? "");
        if (packId) {
          await runtime.playbookEngine.reloadPack(packId);
          return { status: "ok", reloaded: packId };
        }
        // 重载所有 Pack
        const { packs } = (await (
          runtime.playbookEngine as unknown as { reloadPacks?: () => Promise<{ packs: unknown[] }> }
        ).reloadPacks?.()) ?? { packs: [] };
        return { status: "ok", reloaded_count: Array.isArray(packs) ? packs.length : 0 };
      },
    },
  ];
}

// ── L15: connector.* ──────────────────────────────────────────────────────

export function makeConnectorCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "connector.list",
      verb: "query",
      description: "列出所有已配置的连接器及其运行状态",
      owner: { kind: "core" },
      handler: async () => {
        const statusList = runtime.connectorManager.status();
        return {
          connectors: statusList,
          total: statusList.length,
        };
      },
    },

    {
      id: "connector.status",
      verb: "query",
      description: "查询单个连接器的运行状态",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["connector_id"],
        properties: { connector_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const connectorId = String(params.connector_id ?? "");
        const found = runtime.connectorManager.status().find((s) => s.id === connectorId);
        if (!found) {
          return { status: "not_found", connector_id: connectorId };
        }
        return { connector_id: connectorId, ...found };
      },
    },

    {
      id: "connector.invoke",
      verb: "deliver",
      description: "调用连接器的一个方法（需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "直接调用连接器方法可能产生外部副作用" },
      paramsSchema: {
        type: "object",
        required: ["connector_id", "method"],
        properties: {
          connector_id: { type: "string" },
          method: { type: "string" },
          params: { type: "object" },
        },
      },
      handler: async (ctx, params) => {
        const connectorId = String(params.connector_id ?? "");
        const method = String(params.method ?? "");
        const methodParams = (params.params as Record<string, unknown> | undefined) ?? {};

        await runtime.kernel.publish("connector.invoke_started", "connector.invoke", {
          connector_id: connectorId,
          method,
          correlationId: ctx.correlationId,
        });

        const result = await runtime.connectorManager.invoke(connectorId, method, methodParams);
        return { status: "ok", connector_id: connectorId, method, result };
      },
    },
  ];
}

// ── L16: schedule.* ───────────────────────────────────────────────────────

export function makeScheduleCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  // Track dynamically-added cron overrides so schedule.remove doesn't lose them
  // during reload. Key = playbook_id, value = minimal PlaybookDefinition with schedule trigger.
  const dynamicSchedules = new Map<
    string,
    import("../planes/orch/playbook-types.js").PlaybookDefinition
  >();

  return [
    {
      id: "schedule.list",
      verb: "query",
      description: "列出所有通过 Playbook 定义的计划任务",
      owner: { kind: "core" },
      handler: async () => {
        const scheduled = runtime.playbookEngine
          .list()
          .filter((p) => p.trigger.kind === "schedule");
        return {
          tasks: scheduled.map((p) => ({
            playbook_id: p.id,
            name: p.name,
            cron: (p.trigger as { cron?: string }).cron,
            timezone: (p.trigger as { timezone?: string }).timezone,
          })),
          total: scheduled.length,
        };
      },
    },

    {
      id: "schedule.add",
      verb: "control",
      description: "动态添加一个计划任务（需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "添加计划任务会产生周期性副作用" },
      paramsSchema: {
        type: "object",
        required: ["playbook_id", "cron"],
        properties: {
          playbook_id: { type: "string" },
          cron: { type: "string", description: "cron 表达式，如 '0 9 * * *'" },
          timezone: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const playbookId = String(params.playbook_id ?? "");
        const cron = String(params.cron ?? "");
        const timezone = params.timezone ? String(params.timezone) : undefined;

        if (!playbookId || !cron) {
          return { status: "error", reason: "缺少必需参数：playbook_id 和 cron 表达式" };
        }

        // Verify the playbook exists
        const existing = runtime.playbookEngine.list().find((p) => p.id === playbookId);
        if (!existing) {
          return { status: "error", reason: `Playbook「${playbookId}」不存在，请检查 playbook_id` };
        }

        // Build a minimal PlaybookDefinition and register in scheduler
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
        } catch {
          return {
            status: "error",
            reason: `cron 表达式无效：'${cron}'，请使用标准 5 段格式（如 "0 9 * * 1-5"）`,
          };
        }
        // Record so schedule.remove can preserve other dynamic crons during reload
        dynamicSchedules.set(playbookId, dynDef);

        // 持久化到 ObjectStore，重启后可恢复
        await runtime.objectStore
          .upsert("ScheduledTask", playbookId, {
            id: playbookId,
            cron,
            timezone: timezone ?? null,
            playbook_id: playbookId,
            input: {},
            created_at: new Date().toISOString(),
            enabled: true,
          })
          .catch(() => undefined);

        await runtime.kernel
          .publish("schedule.job_registered", "schedule.add", {
            playbook_id: playbookId,
            cron,
            timezone,
          })
          .catch(() => undefined);

        return { status: "registered", playbook_id: playbookId, cron, timezone };
      },
    },

    {
      id: "schedule.remove",
      verb: "control",
      description: "取消一个动态注册的计划任务（重新 reload 可恢复配置中的定时任务）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["playbook_id"],
        properties: { playbook_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const playbookId = String(params.playbook_id ?? "");
        // Remove from dynamic tracking first
        dynamicSchedules.delete(playbookId);
        // Rebuild: static schedule playbooks (excluding removed) + remaining dynamic overrides
        const staticRemaining = runtime.playbookEngine.list().filter((p) => p.id !== playbookId);
        const dynamicRemaining = [...dynamicSchedules.values()].filter((p) => p.id !== playbookId);
        runtime.scheduler.reload([...staticRemaining, ...dynamicRemaining]);
        // 从 ObjectStore 删除持久化记录
        await runtime.objectStore.delete("ScheduledTask", playbookId).catch(() => undefined);
        return { status: "reloaded_without", playbook_id: playbookId };
      },
    },
  ];
}

// ── L17: monitor.* ────────────────────────────────────────────────────────

/** 检查事件类型是否匹配 glob 风格 pattern（支持 "alarm.*"、"*"、精确匹配）。 */
function matchesWatchPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return false;
}

export function makeMonitorCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const watches = new Map<string, { pattern: string; playbookId: string; registeredAt: Date }>();

  // 惰性订阅：首次注册 watch 时在 kernel 事件总线注册 "*" 订阅，
  // 后续所有事件经由此处与已注册的 watches 匹配后触发 playbookEngine。
  let busUnsubscribe: (() => void) | undefined;
  function ensureKernelSubscription(): void {
    if (busUnsubscribe) return;
    busUnsubscribe = runtime.kernel.subscribe("*", async (payload) => {
      const eventType =
        typeof payload._event_type === "string"
          ? payload._event_type
          : typeof payload.type === "string"
            ? payload.type
            : "";
      for (const [watchId, watch] of watches) {
        if (matchesWatchPattern(watch.pattern, eventType)) {
          await runtime.playbookEngine
            .trigger(watch.playbookId, { ...payload, _watch_id: watchId })
            .catch((err: unknown) => {
              runtime.logger?.(
                `[monitor.watch] playbook ${watch.playbookId} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }
    });
  }

  return [
    {
      id: "monitor.watch",
      verb: "observe",
      description:
        "注册一个事件模式监控，当匹配时触发指定 Playbook（支持 alarm.*、* 等 glob 模式）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["event_pattern", "playbook_id"],
        properties: {
          event_pattern: {
            type: "string",
            description: "事件类型 glob（如 alarm.*、work_order.created）",
          },
          playbook_id: { type: "string" },
          watch_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const pattern = String(params.event_pattern ?? "");
        const playbookId = String(params.playbook_id ?? "");
        const watchId = String(params.watch_id ?? `watch-${Date.now()}`);

        watches.set(watchId, { pattern, playbookId, registeredAt: new Date() });
        // 确保已订阅 kernel 事件总线（仅在第一次 watch 注册时订阅一次）
        ensureKernelSubscription();

        await runtime.kernel.publish("monitor.watch_registered", "monitor.watch", {
          watch_id: watchId,
          event_pattern: pattern,
          playbook_id: playbookId,
        });

        return { status: "ok", watch_id: watchId };
      },
    },

    {
      id: "monitor.unwatch",
      verb: "control",
      description: "取消一个已注册的事件监控",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["watch_id"],
        properties: { watch_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const watchId = String(params.watch_id ?? "");
        const existed = watches.has(watchId);
        watches.delete(watchId);
        if (watches.size === 0 && busUnsubscribe) {
          busUnsubscribe();
          busUnsubscribe = undefined;
        }
        return { status: existed ? "removed" : "not_found", watch_id: watchId };
      },
    },

    {
      id: "monitor.status",
      verb: "query",
      description: "查看当前所有监控注册情况",
      owner: { kind: "core" },
      handler: async () => ({
        watches: [...watches.entries()].map(([id, w]) => Object.assign({ id }, w)),
        total: watches.size,
        active: !!busUnsubscribe,
      }),
    },
  ];
}

// ── L18: nexus.* ──────────────────────────────────────────────────────────

export function makeNexusCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const nexusUrl = () => runtime.config.packs?.registry ?? "http://localhost:18800";

  return [
    {
      id: "nexus.search",
      verb: "retrieve",
      description: "在 Nexus 注册表中搜索可用的 Pack",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          family: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const query = String(params.query ?? "");
        try {
          const url = `${nexusUrl()}/packages`;
          const res = await fetch(url);
          if (!res.ok) {
            return { status: "unavailable", packages: [] };
          }
          const data = (await res.json()) as {
            packages?: Array<{ slug: string; name: string; description?: string }>;
          };
          const packages = data.packages ?? [];
          const filtered = query
            ? packages.filter(
                (p) =>
                  p.slug.includes(query) ||
                  p.name.toLowerCase().includes(query.toLowerCase()) ||
                  (p.description ?? "").toLowerCase().includes(query.toLowerCase()),
              )
            : packages;
          return { status: "ok", packages: filtered, total: filtered.length };
        } catch {
          return { status: "error", packages: [] };
        }
      },
    },

    {
      id: "nexus.publish_capabilities",
      verb: "modify",
      description:
        "将当前机器人的能力清单发布到 KB 的 nexus_registry 命名空间，供其他智能体通过 nexus.search 发现和克隆",
      owner: { kind: "core" },
      handler: async () => {
        const caps = runtime.capabilities?.list() ?? [];
        const playbooks = runtime.playbookEngine?.list() ?? [];
        const robotId = (runtime.robot as unknown as { id?: string })?.id ?? "unknown";
        const manifest = {
          robot_id: robotId,
          robot_name: runtime.identity?.name ?? "ClaWorks",
          capabilities: caps.map((c) => ({ id: c.id, verb: c.verb, description: c.description })),
          playbooks: playbooks.map((p) => ({ id: p.id, name: p.name, description: p.description })),
          published_at: new Date().toISOString(),
        };
        await runtime.kb.ingest(JSON.stringify(manifest), {
          source: `nexus:${robotId}`,
          namespace: "nexus_registry",
        });
        await runtime.kernel
          .publish("nexus.capabilities_published", "nexus.publish_capabilities", {
            robot_id: robotId,
            capability_count: caps.length,
            playbook_count: playbooks.length,
          })
          .catch(() => undefined);
        return { status: "ok", capability_count: caps.length, playbook_count: playbooks.length };
      },
    },

    {
      id: "nexus.describe",
      verb: "query",
      description: "获取 Nexus 中指定 Pack 的详细信息",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["pack_id"],
        properties: { pack_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const packId = String(params.pack_id ?? "");
        try {
          const res = await fetch(`${nexusUrl()}/packages/${packId}`);
          if (!res.ok) {
            return { status: "not_found", pack_id: packId };
          }
          return { status: "ok", ...((await res.json()) as Record<string, unknown>) };
        } catch {
          return { status: "error", pack_id: packId };
        }
      },
    },
  ];
}

// ── L19: guide.* (弱模型辅助) ─────────────────────────────────────────────

/**
 * guide.* 能力专为弱本地模型设计：
 * - 提供参考答案和步骤模板
 * - 机器人只需「对照答案执行」，不需要创新
 * - 所有步骤都有明确的输入输出格式
 */
export function makeGuideCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "guide.list_templates",
      verb: "query",
      description: "列出所有可用的任务模板（弱模型使用：按模板执行无需推理）",
      owner: { kind: "core" },
      handler: async () => {
        // 从 KB 中搜索模板
        const results = await runtime.kb.search("task template playbook guide", { limit: 20 });
        const playbooks = runtime.playbookEngine.list().map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          trigger: p.trigger.kind,
          steps: p.steps.length,
        }));
        return {
          kb_templates: results.slice(0, 5),
          playbooks,
          tip: "Use 'task.run' with playbook_id to execute without LLM reasoning",
        };
      },
    },

    {
      id: "guide.step",
      verb: "compose",
      description: "为弱模型提供单步骤的精确执行指令（含参考答案、格式、验证方法）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", description: "要执行的动作描述" },
          input: { type: "object", description: "当前可用的输入数据" },
        },
      },
      handler: async (_ctx, params) => {
        const action = String(params.action ?? "");
        const input = params.input ?? {};

        // 在 KB 中搜索最相关的步骤模板
        const templates = await runtime.kb.search(action, { limit: 3 });

        // 找到最匹配的 Playbook
        const matchingPlaybooks = runtime.playbookEngine
          .list()
          .filter((p) => {
            const text = `${p.name} ${p.description ?? ""}`.toLowerCase();
            return action
              .toLowerCase()
              .split(" ")
              .some((word) => word.length > 3 && text.includes(word));
          })
          .slice(0, 2);

        const capabilities = runtime.capabilities
          .list()
          .filter((c) => {
            const text = `${c.id} ${c.description}`.toLowerCase();
            return action
              .toLowerCase()
              .split(" ")
              .some((word) => word.length > 3 && text.includes(word));
          })
          .slice(0, 3);

        return {
          action,
          input,
          recommendation: {
            suggested_capabilities: capabilities.map((c) => ({
              id: c.id,
              description: c.description,
              verb: c.verb,
            })),
            suggested_playbooks: matchingPlaybooks.map((p) => ({ id: p.id, name: p.name })),
            kb_references: templates.slice(0, 2),
          },
          execution_hint: capabilities[0]
            ? `直接调用 capabilities.invoke("${capabilities[0].id}", params) 即可执行`
            : `使用 reasoning.decompose 将此任务分解为更小的步骤`,
        };
      },
    },

    {
      id: "guide.fill_template",
      verb: "compose",
      description: "填写一个任务模板并生成可执行的 Playbook 输入参数",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["template_id", "variables"],
        properties: {
          template_id: { type: "string" },
          variables: { type: "object" },
        },
      },
      handler: async (_ctx, params) => {
        const templateId = String(params.template_id ?? "");
        const variables = (params.variables as Record<string, unknown> | undefined) ?? {};

        // 找 Playbook 模板
        const playbook = runtime.playbookEngine.list().find((p) => p.id === templateId);
        if (!playbook) {
          return { status: "not_found", template_id: templateId };
        }

        return {
          status: "ok",
          template_id: templateId,
          playbook_name: playbook.name,
          filled_input: variables,
          execution: {
            capability: "task.run",
            params: { playbook_id: templateId, input: variables },
          },
        };
      },
    },
  ];
}

// ── L20: constitution.* ───────────────────────────────────────────────────

export function makeConstitutionCapabilities(
  runtime: ClaworksRuntime,
  constitution: ConstitutionV2,
): CapabilityDescriptor[] {
  return [
    {
      id: "constitution.describe",
      verb: "query",
      description: "返回当前行为准则的完整描述（四层规则）",
      owner: { kind: "core" },
      handler: async () => constitution.describe() as unknown as Record<string, unknown>,
    },

    {
      id: "constitution.check",
      verb: "query",
      description: "检查一个能力是否被允许执行，以及在哪一层受到限制",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["capability_id"],
        properties: {
          capability_id: { type: "string" },
          source: { type: "string" },
          user_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.capability_id ?? "");
        return constitution.check(id, {
          source: String(params.source ?? ""),
          userId: String(params.user_id ?? ""),
        }) as unknown as Record<string, unknown>;
      },
    },

    {
      id: "constitution.set_user_rule",
      verb: "control",
      description: "为特定用户设置自定义规则（Tier 2），持久化到 ObjectStore",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "修改用户规则影响权限" },
      handler: async (_ctx, params) => {
        const entry = params as Parameters<typeof constitution.setUserRule>[0];
        constitution.setUserRule(entry);
        // 持久化到 ObjectStore，重启后可从 _ConstitutionUserRule 表恢复
        try {
          await runtime.objectStore.upsert("_ConstitutionUserRule", entry.userId, {
            ...entry,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          // DB 写入失败不中断运行，降级为纯内存
        }
        return { status: "ok" };
      },
    },

    {
      id: "constitution.record_feedback",
      verb: "acquire",
      description: "记录一次行为反馈，用于 Tier 3 可进化规则学习",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["capability_id", "direction"],
        properties: {
          capability_id: { type: "string" },
          direction: { type: "string", enum: ["nudge_allow", "nudge_hitl", "style_adjust"] },
          related_run_id: { type: "string" },
          user_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const capabilityId = String(params.capability_id ?? "");
        const direction = params.direction as Parameters<typeof constitution.recordFeedback>[1];
        constitution.recordFeedback(capabilityId, direction);

        // Check if threshold reached so Playbooks can react
        const desc = constitution.describe();
        // learnedCount increases per feedback; publish event for Playbook reaction
        await runtime.kernel
          .publish("capability.feedback_received", "constitution.record_feedback", {
            capability_id: capabilityId,
            direction,
            related_run_id: params.related_run_id ?? null,
            user_id: params.user_id ?? null,
            learned_count: desc.learnedCount,
            // threshold_reached: true when feedbackCount reaches 5 — Playbooks can evolve rules
            threshold_reached: false, // conservative default; evolution Playbook checks its own logic
          })
          .catch(() => undefined);

        return { status: "ok", capability_id: capabilityId, direction };
      },
    },
  ];
}

// ── L21: context.* (对话上下文) ───────────────────────────────────────────

export function makeContextCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "context.append",
      verb: "observe",
      description: "追加一条对话记录到会话上下文",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["session_id", "role", "content"],
        properties: {
          session_id: { type: "string" },
          role: { type: "string", enum: ["user", "assistant", "system"] },
          content: { type: "string" },
          meta: { type: "object" },
        },
      },
      handler: async (_ctx, params) => {
        const sessionId = String(params.session_id ?? "");
        const role = String(params.role ?? "user") as "user" | "assistant" | "system";
        const content = String(params.content ?? "");
        const meta = (params.meta as Record<string, unknown> | undefined) ?? undefined;
        runtime.contextEngine?.append(sessionId, role, content, meta);
        return { status: "ok", session_id: sessionId };
      },
    },
    {
      id: "context.get",
      verb: "retrieve",
      description: "获取会话上下文（最近 N 轮对话）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: { type: "string" },
          max_turns: { type: "integer", default: 10 },
        },
      },
      handler: async (_ctx, params) => {
        const sessionId = String(params.session_id ?? "");
        const maxTurns = typeof params.max_turns === "number" ? params.max_turns : 10;
        const turns = runtime.contextEngine?.getRecent(sessionId, maxTurns) ?? [];
        return { session_id: sessionId, turns, count: turns.length };
      },
    },
    {
      id: "context.clear",
      verb: "control",
      description: "清除指定会话的上下文",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["session_id"],
        properties: { session_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        runtime.contextEngine?.clear(String(params.session_id ?? ""));
        return { status: "ok" };
      },
    },
    {
      id: "context.list",
      verb: "query",
      description: "列出所有活跃会话摘要",
      owner: { kind: "core" },
      handler: async () => {
        const sessions = runtime.contextEngine?.listSessions() ?? [];
        return { sessions, count: sessions.length };
      },
    },
  ];
}

// ── L22: memory.case_* (CBR 案例记忆) ─────────────────────────────────────

export function makeCbrCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "memory.case_search",
      verb: "retrieve",
      description: "搜索相似历史案例（Case-Based Reasoning）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 5 },
        },
      },
      handler: async (_ctx, params) => {
        const query = String(params.query ?? "");
        const limit = typeof params.limit === "number" ? params.limit : 5;
        const cases = runtime.cbrStore?.search(query, limit) ?? [];
        return { cases, count: cases.length };
      },
    },
    {
      id: "memory.case_record",
      verb: "acquire",
      description: "记录新案例（Playbook 成功/失败后调用，积累经验）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["problem", "solution"],
        properties: {
          problem: { type: "string" },
          solution: { type: "string" },
          outcome: { type: "string", enum: ["success", "partial", "failed"] },
          tags: { type: "array", items: { type: "string" } },
          playbook_id: { type: "string" },
          run_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const caseEntry = runtime.cbrStore?.add(
          String(params.problem ?? ""),
          String(params.solution ?? ""),
          {
            outcome: (params.outcome as "success" | "partial" | "failed" | undefined) ?? "success",
            tags: Array.isArray(params.tags) ? (params.tags as string[]) : undefined,
            playbookId: params.playbook_id ? String(params.playbook_id) : undefined,
            runId: params.run_id ? String(params.run_id) : undefined,
          },
        );
        return { status: "ok", case_id: caseEntry?.id };
      },
    },
    {
      id: "memory.case_outcome",
      verb: "acquire",
      description: "更新案例结果（成功/部分成功/失败）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["case_id", "outcome"],
        properties: {
          case_id: { type: "string" },
          outcome: { type: "string", enum: ["success", "partial", "failed"] },
        },
      },
      handler: async (_ctx, params) => {
        const caseId = String(params.case_id ?? "");
        const outcome = params.outcome as "success" | "partial" | "failed";
        runtime.cbrStore?.recordOutcome(caseId, outcome);
        return { status: "ok", case_id: caseId, outcome };
      },
    },
  ];
}

// ── L23: hook.* (事件主动推送) ────────────────────────────────────────────

export function makeHookCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "hook.register",
      verb: "control",
      description: "注册一个事件 Hook（事件触发后推送到外部系统；需要 HITL，因为会产生外部副作用）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "注册 Hook 会产生外部副作用" },
      paramsSchema: {
        type: "object",
        required: ["name", "event_pattern", "action_kind", "template"],
        properties: {
          name: { type: "string" },
          event_pattern: { type: "string" },
          condition: { type: "string" },
          action_kind: {
            type: "string",
            enum: ["im_notify", "webhook", "playbook", "a2a_delegate"],
          },
          channel: { type: "string" },
          url: { type: "string" },
          playbook_id: { type: "string" },
          template: { type: "string" },
          headers: { type: "object" },
        },
      },
      handler: async (_ctx, params) => {
        const hook = runtime.hookEngine?.register({
          name: String(params.name ?? ""),
          trigger: {
            eventPattern: String(params.event_pattern ?? ""),
            condition: params.condition ? String(params.condition) : undefined,
          },
          action: {
            kind:
              (params.action_kind as "im_notify" | "webhook" | "playbook" | "a2a_delegate") ??
              "im_notify",
            channel: params.channel ? String(params.channel) : undefined,
            url: params.url ? String(params.url) : undefined,
            playbookId: params.playbook_id ? String(params.playbook_id) : undefined,
            template: String(params.template ?? ""),
            headers: (params.headers as Record<string, string> | undefined) ?? undefined,
          },
          enabled: true,
        });
        return {
          status: "ok",
          hook_id: (hook as Record<string, unknown>)?.id,
          name: (hook as Record<string, unknown>)?.name,
        };
      },
    },
    {
      id: "hook.unregister",
      verb: "control",
      description: "取消一个已注册的 Hook",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["hook_id"],
        properties: { hook_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const removed = runtime.hookEngine?.unregister(String(params.hook_id ?? ""));
        return { status: removed ? "removed" : "not_found" };
      },
    },
    {
      id: "hook.list",
      verb: "query",
      description: "列出所有已注册的 Hook",
      owner: { kind: "core" },
      handler: async () => {
        const hooks = runtime.hookEngine?.list() ?? [];
        return { hooks, count: hooks.length };
      },
    },
    {
      id: "hook.enable",
      verb: "control",
      description: "启用一个 Hook",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["hook_id"],
        properties: { hook_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        runtime.hookEngine?.enable(String(params.hook_id ?? ""));
        return { status: "ok" };
      },
    },
    {
      id: "hook.disable",
      verb: "control",
      description: "禁用一个 Hook",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["hook_id"],
        properties: { hook_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        runtime.hookEngine?.disable(String(params.hook_id ?? ""));
        return { status: "ok" };
      },
    },
  ];
}

// ── L24: provider.* (Provider 注册表) ────────────────────────────────────

export function makeProviderCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "provider.list",
      verb: "query",
      description: "列出所有已注册的 Provider（LLM/KB/Notify/Connector）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["llm", "kb", "notify", "connector"] },
        },
      },
      handler: async (_ctx, params) => {
        const kind = params.kind as "llm" | "kb" | "notify" | "connector" | undefined;
        const providers = runtime.providerRegistry?.list(kind) ?? [];
        return {
          providers: providers.map((p) => ({
            id: p.id,
            kind: p.kind,
            name: p.name,
            priority: p.priority,
            available:
              typeof p.available === "function" ? (p.available as () => boolean)() : p.available,
            meta: p.meta,
          })),
          count: providers.length,
        };
      },
    },
    {
      id: "provider.status",
      verb: "query",
      description: "查看指定 Provider 的可用性",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["provider_id"],
        properties: { provider_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const id = String(params.provider_id ?? "");
        const available = runtime.providerRegistry?.isAvailable(id);
        const all = runtime.providerRegistry?.list() ?? [];
        const provider = all.find((p) => p.id === id);
        if (!provider) {
          return { status: "not_found", provider_id: id };
        }
        return {
          provider_id: id,
          available,
          kind: provider.kind,
          name: provider.name,
          priority: provider.priority,
        };
      },
    },
  ];
}

// ── L25: task.create/update/list/assign (业务任务管理) ──────────────────

export function makeTaskManagementCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const TASK_TYPE = "task";
  return [
    {
      id: "task.create",
      verb: "transform",
      description: "创建任务（存入 ObjectStore）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "创建任务需要人工确认" },
      paramsSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          assignee: { type: "string" },
          priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
          due_date: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      handler: async (ctx, params) => {
        const now = new Date().toISOString();
        const task = await runtime.objectStore.create(
          TASK_TYPE,
          {
            title: String(params.title ?? ""),
            description: params.description ? String(params.description) : undefined,
            assignee: params.assignee ? String(params.assignee) : undefined,
            priority: String(params.priority ?? "normal"),
            status: "open",
            due_date: params.due_date ? String(params.due_date) : undefined,
            tags: Array.isArray(params.tags) ? params.tags : [],
            created_at: now,
            updated_at: now,
          },
          ctx.stepCtx ?? ({} as never),
        );
        await runtime.kernel
          .publish(CW_EVENTS.TASK_CREATED, "task.create", {
            task_id: task.id,
            title: params.title,
          })
          .catch(() => undefined);
        return { status: "ok", task_id: task.id, ...task };
      },
    },
    {
      id: "task.update",
      verb: "transform",
      description: "更新任务状态或字段",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
          assignee: { type: "string" },
          priority: { type: "string" },
          title: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const { task_id: taskId, status: newStatus, ...fields } = params;
        const id = String(taskId ?? "");
        const oldRecord = await runtime.objectStore.get(TASK_TYPE, id).catch(() => undefined);
        const oldStatus = oldRecord
          ? String((oldRecord as Record<string, unknown>).status ?? "")
          : "";
        const updated = await runtime.objectStore.update(TASK_TYPE, id, {
          ...(newStatus !== undefined ? { status: newStatus } : {}),
          ...fields,
          updated_at: new Date().toISOString(),
        });

        if (newStatus !== undefined && newStatus !== oldStatus) {
          const statusPayload = {
            task_id: id,
            old_status: oldStatus,
            new_status: String(newStatus),
          };
          await runtime.kernel
            .publish(CW_EVENTS.TASK_STATUS_CHANGED, "task.update", statusPayload)
            .catch(() => undefined);
          if (newStatus === "done") {
            await runtime.kernel
              .publish(CW_EVENTS.TASK_COMPLETED, "task.update", {
                task_id: id,
                completed_at: new Date().toISOString(),
              })
              .catch(() => undefined);
          } else if (newStatus === "cancelled") {
            await runtime.kernel
              .publish(CW_EVENTS.TASK_CANCELLED, "task.update", { task_id: id })
              .catch(() => undefined);
          }
        }

        return { status: "ok", task_id: id, ...updated };
      },
    },
    {
      id: "task.list",
      verb: "retrieve",
      description: "按条件列出任务",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          assignee: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.status) {
          filter.status = params.status;
        }
        if (params.assignee) {
          filter.assignee = params.assignee;
        }
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const { items } = await runtime.objectStore.query(TASK_TYPE, { filter, limit });
        return { tasks: items, count: items.length };
      },
    },
    {
      id: "task.assign",
      verb: "deliver",
      description: "分配任务给用户",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["task_id", "assignee"],
        properties: {
          task_id: { type: "string" },
          assignee: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.task_id ?? "");
        const assignee = String(params.assignee ?? "");
        const updated = await runtime.objectStore.update(TASK_TYPE, id, {
          assignee,
          updated_at: new Date().toISOString(),
        });
        await runtime.kernel
          .publish(CW_EVENTS.TASK_ASSIGNED, "task.assign", {
            task_id: id,
            assignee,
          })
          .catch(() => undefined);
        return { status: "ok", task_id: id, assignee, ...updated };
      },
    },
  ];
}

// ── L26: report.* (报告生成) ──────────────────────────────────────────────

export function makeReportCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const REPORT_TYPE = "report";
  return [
    {
      id: "report.generate",
      verb: "compose",
      description: "生成结构化报告（汇总数据、Playbook 运行记录等）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["title", "content"],
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          report_type: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
      handler: async (ctx, params) => {
        const now = new Date().toISOString();
        const report = await runtime.objectStore.create(
          REPORT_TYPE,
          {
            title: String(params.title ?? ""),
            content: String(params.content ?? ""),
            report_type: String(params.report_type ?? "generic"),
            tags: Array.isArray(params.tags) ? params.tags : [],
            source: params.source ? String(params.source) : (ctx.source ?? "system"),
            status: "published",
            created_at: now,
          },
          ctx.stepCtx ?? ({} as never),
        );
        await runtime.kernel
          .publish("report.generated", "report.generate", {
            report_id: report.id,
            title: params.title,
          })
          .catch(() => undefined);
        return { status: "ok", report_id: report.id, ...report };
      },
    },
    {
      id: "report.list",
      verb: "retrieve",
      description: "列出已生成的报告",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          report_type: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.report_type) {
          filter.report_type = params.report_type;
        }
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const { items } = await runtime.objectStore.query(REPORT_TYPE, { filter, limit });
        return { reports: items, count: items.length };
      },
    },
    {
      id: "report.export",
      verb: "deliver",
      description: "导出报告内容（返回结构化文本）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["report_id"],
        properties: {
          report_id: { type: "string" },
          format: { type: "string", enum: ["text", "json", "markdown"], default: "text" },
        },
      },
      handler: async (_ctx, params) => {
        const reportId = String(params.report_id ?? "");
        const format = String(params.format ?? "text");
        const { items } = await runtime.objectStore.query(REPORT_TYPE, {
          filter: { id: reportId },
          limit: 1,
        });
        if (items.length === 0) {
          return { status: "not_found", report_id: reportId };
        }
        const report = items[0] as Record<string, unknown>;
        if (format === "json") {
          return { status: "ok", report_id: reportId, data: report };
        }
        if (format === "markdown") {
          const title = String(report.title ?? "Report");
          const content = String(report.content ?? "");
          return {
            status: "ok",
            report_id: reportId,
            text: `# ${title}\n\n${content}`,
          };
        }
        return {
          status: "ok",
          report_id: reportId,
          text: String(report.content ?? ""),
        };
      },
    },
  ];
}

// ── L27: approval.* (审批流) ──────────────────────────────────────────────

export function makeApprovalCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const APPROVAL_TYPE = "approval";

  async function triggerHitlNotify(
    approverIds: string[],
    approvalId: string,
    title: string,
  ): Promise<void> {
    await runtime.kernel
      .publish("approval.hitl_requested", "approval.create", {
        approval_id: approvalId,
        title,
        approver_ids: approverIds,
      })
      .catch(() => undefined);
  }

  return [
    {
      id: "approval.create",
      verb: "transform",
      description: "创建审批记录（写入 ObjectStore），发布 approval.created 事件并触发 HITL 通知",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["title", "applicant_id", "approver_ids"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          applicant_id: { type: "string" },
          approver_ids: { type: "array", items: { type: "string" } },
          type: { type: "string", default: "generic" },
          payload: { type: "object" },
        },
      },
      handler: async (ctx, params) => {
        const now = new Date().toISOString();
        const approverIds = Array.isArray(params.approver_ids)
          ? (params.approver_ids as string[])
          : [String(params.approver_ids ?? "")];
        const record = await runtime.objectStore.create(
          APPROVAL_TYPE,
          {
            title: String(params.title ?? ""),
            description: params.description ? String(params.description) : undefined,
            applicant_id: String(params.applicant_id ?? ""),
            approver_ids: approverIds,
            type: String(params.type ?? "generic"),
            payload: (params.payload as Record<string, unknown> | undefined) ?? {},
            status: "pending",
            created_at: now,
            updated_at: now,
          },
          ctx.stepCtx ?? ({} as never),
        );
        await runtime.kernel
          .publish("approval.created", "approval.create", {
            approval_id: record.id,
            title: params.title,
            applicant_id: params.applicant_id,
            approver_ids: approverIds,
            status: "pending",
          })
          .catch(() => undefined);
        await triggerHitlNotify(approverIds, record.id, String(params.title ?? ""));
        return { status: "ok", approval_id: record.id, ...record };
      },
    },

    {
      id: "approval.get",
      verb: "retrieve",
      description: "按 ID 获取审批详情",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["approval_id"],
        properties: { approval_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const id = String(params.approval_id ?? "");
        const { items } = await runtime.objectStore.query(APPROVAL_TYPE, {
          filter: { id },
          limit: 1,
        });
        if (items.length === 0) {
          return { status: "not_found", approval_id: id };
        }
        return { status: "ok", ...(items[0] as Record<string, unknown>) };
      },
    },

    {
      id: "approval.list",
      verb: "retrieve",
      description: "列出审批记录（支持 filter: status/applicant_id/approver_id）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "approved", "rejected"] },
          applicant_id: { type: "string" },
          approver_id: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.status) {
          filter.status = params.status;
        }
        if (params.applicant_id) {
          filter.applicant_id = params.applicant_id;
        }
        // approver_id 过滤需要在应用层处理（approver_ids 是数组）
        const limit = typeof params.limit === "number" ? params.limit : 20;
        let { items } = await runtime.objectStore.query(APPROVAL_TYPE, { filter, limit });
        if (params.approver_id) {
          const aid = String(params.approver_id);
          items = items.filter((item) => {
            const ids = (item as Record<string, unknown>).approver_ids;
            return Array.isArray(ids) && ids.includes(aid);
          });
        }
        return { approvals: items, count: items.length };
      },
    },

    {
      id: "approval.approve",
      verb: "transform",
      description: "审批通过（更新状态 → approved，发布 approval.approved 事件）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["approval_id"],
        properties: {
          approval_id: { type: "string" },
          comment: { type: "string" },
          approver_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.approval_id ?? "");
        const now = new Date().toISOString();
        const updated = await runtime.objectStore.update(APPROVAL_TYPE, id, {
          status: "approved",
          decision: "approved",
          approver_id: params.approver_id ? String(params.approver_id) : undefined,
          comment: params.comment ? String(params.comment) : undefined,
          decided_at: now,
          updated_at: now,
        });
        await runtime.kernel
          .publish("approval.approved", "approval.approve", {
            approval_id: id,
            decision: "approved",
            approver_id: params.approver_id ?? null,
            comment: params.comment ?? null,
            ...((updated ?? {}) as Record<string, unknown>),
          })
          .catch(() => undefined);
        return { status: "ok", approval_id: id, decision: "approved", ...updated };
      },
    },

    {
      id: "approval.reject",
      verb: "transform",
      description: "审批拒绝（更新状态 → rejected，发布 approval.rejected 事件）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["approval_id"],
        properties: {
          approval_id: { type: "string" },
          reason: { type: "string" },
          approver_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.approval_id ?? "");
        const now = new Date().toISOString();
        const updated = await runtime.objectStore.update(APPROVAL_TYPE, id, {
          status: "rejected",
          decision: "rejected",
          approver_id: params.approver_id ? String(params.approver_id) : undefined,
          reason: params.reason ? String(params.reason) : undefined,
          decided_at: now,
          updated_at: now,
        });
        await runtime.kernel
          .publish("approval.rejected", "approval.reject", {
            approval_id: id,
            decision: "rejected",
            approver_id: params.approver_id ?? null,
            reason: params.reason ?? null,
            ...((updated ?? {}) as Record<string, unknown>),
          })
          .catch(() => undefined);
        return { status: "ok", approval_id: id, decision: "rejected", ...updated };
      },
    },
  ];
}

// ── L28: work_order.* (工单管理，core 注册，供 base pack Playbook 调用) ───────

export function makeWorkOrderCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const WO_TYPE = "work_order";

  return [
    {
      id: "work_order.create",
      verb: "transform",
      description: "创建工单（objectStore type=work_order），创建后发布 work_order.created 事件",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          equipment_id: { type: "string" },
          priority: {
            type: "string",
            enum: ["urgent", "high", "normal", "low"],
            default: "normal",
          },
          assigned_to: { type: "string" },
        },
      },
      handler: async (ctx, params) => {
        const now = new Date().toISOString();
        const wo = await runtime.objectStore.create(
          WO_TYPE,
          {
            title: String(params.title ?? ""),
            description: params.description ? String(params.description) : undefined,
            equipment_id: params.equipment_id ? String(params.equipment_id) : undefined,
            priority: String(params.priority ?? "normal"),
            assigned_to: params.assigned_to ? String(params.assigned_to) : undefined,
            status: "open",
            created_at: now,
            updated_at: now,
          },
          ctx.stepCtx ?? ({} as never),
        );
        await runtime.kernel
          .publish(CW_EVENTS.WORK_ORDER_CREATED, "work_order.create", {
            work_order_id: wo.id,
            title: params.title,
            equipment_id: params.equipment_id ?? null,
            priority: params.priority ?? "normal",
            assigned_to: params.assigned_to ?? null,
            status: "open",
          })
          .catch(() => undefined);
        return { status: "ok", work_order_id: wo.id, ...wo };
      },
    },

    {
      id: "work_order.get",
      verb: "retrieve",
      description: "按 ID 获取工单详情",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["work_order_id"],
        properties: { work_order_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const id = String(params.work_order_id ?? "");
        const { items } = await runtime.objectStore.query(WO_TYPE, { filter: { id }, limit: 1 });
        if (items.length === 0) {
          return { status: "not_found", work_order_id: id };
        }
        return { status: "ok", ...(items[0] as Record<string, unknown>) };
      },
    },

    {
      id: "work_order.list",
      verb: "retrieve",
      description: "列出工单（filter: status/assigned_to/equipment_id）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          assigned_to: { type: "string" },
          equipment_id: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.status) {
          filter.status = params.status;
        }
        if (params.assigned_to) {
          filter.assigned_to = params.assigned_to;
        }
        if (params.equipment_id) {
          filter.equipment_id = params.equipment_id;
        }
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const { items } = await runtime.objectStore.query(WO_TYPE, { filter, limit });
        return { work_orders: items, count: items.length };
      },
    },

    {
      id: "work_order.close",
      verb: "transform",
      description: "关闭工单（更新状态 + 记录 close_reason + 写 CBR 案例）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["work_order_id"],
        properties: {
          work_order_id: { type: "string" },
          close_reason: { type: "string" },
          resolution: { type: "string" },
        },
      },
      handler: async (ctx, params) => {
        const id = String(params.work_order_id ?? "");
        const now = new Date().toISOString();
        const closeReason = params.close_reason ? String(params.close_reason) : "closed";
        const resolution = params.resolution ? String(params.resolution) : "";
        const updated = await runtime.objectStore.update(WO_TYPE, id, {
          status: "closed",
          close_reason: closeReason,
          resolution,
          closed_at: now,
          updated_at: now,
        });
        // 写 CBR 案例记录
        if (resolution) {
          runtime.cbrStore?.add(`work_order:${id}`, resolution, {
            outcome: "success",
            tags: ["work_order", "closed"],
            playbookId: ctx.stepCtx
              ? String((ctx.stepCtx as unknown as Record<string, unknown>).playbookId ?? "")
              : undefined,
          });
        }
        const statusPayload = {
          work_order_id: id,
          old_status: "open",
          new_status: "closed",
          changed_by: "system",
          close_reason: closeReason,
          resolution,
          ...((updated ?? {}) as Record<string, unknown>),
        };
        await runtime.kernel
          .publish(CW_EVENTS.WORK_ORDER_CLOSED, "work_order.close", statusPayload)
          .catch(() => undefined);
        // 同时发布通用状态变更事件，供 work_order_status_track Playbook 消费
        await runtime.kernel
          .publish(CW_EVENTS.WORK_ORDER_STATUS_CHANGED, "work_order.close", statusPayload)
          .catch(() => undefined);
        return { status: "ok", work_order_id: id, close_reason: closeReason, ...updated };
      },
    },
    // ── work_order.update_status ───────────────────────────────────────────────
    {
      id: "work_order.update_status",
      verb: "transform",
      description: "变更工单状态，发布 work_order.status_changed 事件",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["work_order_id", "status"],
        properties: {
          work_order_id: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "in_progress", "on_hold", "completed", "closed", "cancelled"],
          },
          changed_by: { type: "string" },
          note: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.work_order_id ?? "");
        const newStatus = String(params.status ?? "");
        const oldRecord = await runtime.objectStore.get(WO_TYPE, id).catch(() => undefined);
        const oldStatus = oldRecord
          ? String((oldRecord as Record<string, unknown>).status ?? "open")
          : "open";
        const updated = await runtime.objectStore.update(WO_TYPE, id, {
          status: newStatus,
          updated_at: new Date().toISOString(),
          ...(params.note ? { note: String(params.note) } : {}),
        });
        const statusPayload = {
          work_order_id: id,
          old_status: oldStatus,
          new_status: newStatus,
          changed_by: params.changed_by ? String(params.changed_by) : "system",
          ...((updated ?? {}) as Record<string, unknown>),
        };
        await runtime.kernel
          .publish(CW_EVENTS.WORK_ORDER_STATUS_CHANGED, "work_order.update_status", statusPayload)
          .catch(() => undefined);
        return { status: "ok", work_order_id: id, new_status: newStatus, ...updated };
      },
    },
  ];
}

// ── L29: alarm.* (报警管理，core 注册，供 base pack Playbook 调用) ──────────

export function makeAlarmCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  const ALARM_TYPE = "alarm";

  return [
    {
      id: "alarm.acknowledge",
      verb: "transform",
      description: "确认报警（更新 acknowledged=true），发布 alarm.acknowledged 事件",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["alarm_id"],
        properties: {
          alarm_id: { type: "string" },
          acknowledged_by: { type: "string" },
          comment: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.alarm_id ?? "");
        const now = new Date().toISOString();
        const updated = await runtime.objectStore.update(ALARM_TYPE, id, {
          acknowledged: true,
          acknowledged_by: params.acknowledged_by ? String(params.acknowledged_by) : undefined,
          acknowledged_at: now,
          ack_comment: params.comment ? String(params.comment) : undefined,
          updated_at: now,
        });
        await runtime.kernel
          .publish("alarm.acknowledged", "alarm.acknowledge", {
            alarm_id: id,
            acknowledged: true,
            acknowledged_by: params.acknowledged_by ?? null,
            ...((updated ?? {}) as Record<string, unknown>),
          })
          .catch(() => undefined);
        return { status: "ok", alarm_id: id, acknowledged: true, ...updated };
      },
    },

    {
      id: "alarm.list",
      verb: "retrieve",
      description: "列出报警（filter: status/equipment_id/severity）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "acknowledged", "resolved"] },
          equipment_id: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          limit: { type: "integer", default: 20 },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.status) {
          filter.status = params.status;
        }
        if (params.equipment_id) {
          filter.equipment_id = params.equipment_id;
        }
        if (params.severity) {
          filter.severity = params.severity;
        }
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const { items } = await runtime.objectStore.query(ALARM_TYPE, { filter, limit });
        return { alarms: items, count: items.length };
      },
    },

    {
      id: "alarm.resolve",
      verb: "transform",
      description: "标记报警已解决，发布 alarm.resolved 事件",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["alarm_id"],
        properties: {
          alarm_id: { type: "string" },
          resolution: { type: "string" },
          resolved_by: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.alarm_id ?? "");
        const now = new Date().toISOString();
        const updated = await runtime.objectStore.update(ALARM_TYPE, id, {
          status: "resolved",
          resolved: true,
          resolved_by: params.resolved_by ? String(params.resolved_by) : undefined,
          resolution: params.resolution ? String(params.resolution) : undefined,
          resolved_at: now,
          updated_at: now,
        });
        await runtime.kernel
          .publish("alarm.resolved", "alarm.resolve", {
            alarm_id: id,
            resolved: true,
            resolved_by: params.resolved_by ?? null,
            resolution: params.resolution ?? null,
            ...((updated ?? {}) as Record<string, unknown>),
          })
          .catch(() => undefined);
        return { status: "ok", alarm_id: id, resolved: true, ...updated };
      },
    },
  ];
}

// ── L30: notify.* (通知路由) ──────────────────────────────────────────────

export function makeNotifyCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "notify.dispatch",
      verb: "deliver",
      description: "核心通知路由：根据 subject/role 找到责任人，按用户偏好渠道发送（渠道无关）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["subject_type"],
        properties: {
          subject_type: {
            type: "string",
            description: "主体类型：equipment / department / role / user",
          },
          subject_id: { type: "string", description: "主体 ID（设备号、部门 ID、角色名、userId）" },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            default: "normal",
            description: "优先级；critical/high 向所有注册渠道发送，normal/low 只用首选渠道",
          },
          title: { type: "string", description: "通知标题（可选）" },
          message: { type: "string", description: "通知正文（与 card_template 二选一）" },
          card_template: {
            type: "string",
            enum: ["alarm", "work_order", "approval", "report", "health"],
            description: "卡片模板名称，与 card_data 配合使用（会覆盖 message）",
          },
          card_data: { type: "object", description: "传给卡片模板的字段数据" },
          metadata: { type: "object", description: "附加业务元数据（不显示给用户）" },
        },
      },
      handler: async (_ctx, params) => {
        // 卡片模板路径：构建卡片并把它序列化到 message 中（渠道适配在 comms.send 层完成）
        let message = params.message ? String(params.message) : "";
        let cardPayload: Record<string, unknown> | undefined;
        if (params.card_template) {
          const tpl = String(params.card_template);
          const data = (params.card_data as Record<string, unknown> | undefined) ?? {};
          const cb = runtime.cardBuilder;
          if (cb) {
            try {
              let card;
              if (tpl === "alarm") {
                card = cb.alarm({
                  alarmId: String(data.alarm_id ?? data.alarmId ?? ""),
                  equipmentId: String(data.equipment_id ?? data.equipmentId ?? ""),
                  severity: String(data.severity ?? "medium"),
                  description: String(data.description ?? ""),
                  time: data.time ? String(data.time) : undefined,
                });
              } else if (tpl === "work_order") {
                card = cb.workOrder({
                  id: String(data.id ?? ""),
                  title: String(data.title ?? ""),
                  status: String(data.status ?? "open"),
                  assignee: String(data.assignee ?? ""),
                  priority: String(data.priority ?? "normal"),
                  equipment: data.equipment ? String(data.equipment) : undefined,
                });
              } else if (tpl === "approval") {
                card = cb.approval({
                  id: String(data.id ?? ""),
                  title: String(data.title ?? ""),
                  applicant: String(data.applicant ?? ""),
                  status: String(data.status ?? "pending"),
                  description: data.description ? String(data.description) : undefined,
                });
              } else if (tpl === "report") {
                card = cb.report({
                  title: String(data.title ?? "报告"),
                  period: String(data.period ?? ""),
                  metrics: Array.isArray(data.metrics)
                    ? (data.metrics as Array<{ label: string; value: string }>)
                    : [],
                });
              } else if (tpl === "health") {
                card = cb.healthStatus({
                  overall: String(data.overall ?? "ok"),
                  dimensions: Array.isArray(data.dimensions)
                    ? (data.dimensions as Array<{ name: string; status: string; note?: string }>)
                    : [],
                });
              }
              if (card) {
                cardPayload = { card };
                if (!message) message = cb.toPlainText(card);
              }
            } catch {
              // 卡片构建失败降级为纯文本
            }
          }
        }

        if (!runtime.notificationRouter) {
          // notificationRouter 未初始化时降级：直接走 notify bridge
          const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
          if (notifyBridge) {
            await notifyBridge.send({ message });
          } else {
            runtime.logger?.(`[notify.dispatch/no-router] ${message}`);
          }
          return { sent: 1, recipients: ["default"], channels: ["default"] };
        }
        const result = await runtime.notificationRouter.dispatch({
          subjectType: String(params.subject_type ?? "user"),
          subjectId: params.subject_id ? String(params.subject_id) : undefined,
          priority: (params.priority as "low" | "normal" | "high" | "critical") ?? "normal",
          title: params.title ? String(params.title) : undefined,
          message,
          metadata: {
            ...((params.metadata as Record<string, unknown> | undefined) ?? {}),
            ...cardPayload,
          },
        });
        return result as unknown as Record<string, unknown>;
      },
    },

    {
      id: "notify.subscribe",
      verb: "control",
      description: "用户订阅某类事件通知，并指定接收渠道",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["user_id", "event_patterns", "channels"],
        properties: {
          user_id: { type: "string" },
          event_patterns: {
            type: "array",
            items: { type: "string" },
            description: "事件模式，如 ['alarm.*']",
          },
          channels: {
            type: "array",
            items: { type: "string" },
            description: "偏好渠道列表（优先级顺序）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const userId = String(params.user_id ?? "");
        const patterns = Array.isArray(params.event_patterns)
          ? (params.event_patterns as string[])
          : [];
        const channels = Array.isArray(params.channels) ? (params.channels as string[]) : [];

        const existing = runtime.notificationRouter?.getPreference(userId);
        const mergedPatterns = [...new Set([...(existing?.subscriptions ?? []), ...patterns])];
        const mergedChannels = [...new Set([...channels, ...(existing?.channels ?? [])])];

        runtime.notificationRouter?.setPreference(userId, {
          channels: mergedChannels,
          subscriptions: mergedPatterns,
        });
        return {
          status: "ok",
          user_id: userId,
          subscriptions: mergedPatterns,
          channels: mergedChannels,
        };
      },
    },

    {
      id: "notify.unsubscribe",
      verb: "control",
      description: "取消用户对某类事件的订阅",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["user_id"],
        properties: {
          user_id: { type: "string" },
          event_patterns: {
            type: "array",
            items: { type: "string" },
            description: "要取消的事件模式（不填则清除所有订阅）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const userId = String(params.user_id ?? "");
        const toRemove = Array.isArray(params.event_patterns)
          ? (params.event_patterns as string[])
          : null;
        const existing = runtime.notificationRouter?.getPreference(userId);
        if (!existing) {
          return { status: "not_found", user_id: userId };
        }

        const subscriptions = toRemove
          ? existing.subscriptions.filter((s) => !toRemove.includes(s))
          : [];
        runtime.notificationRouter?.setPreference(userId, { subscriptions });
        return { status: "ok", user_id: userId, subscriptions };
      },
    },

    {
      id: "notify.preferences",
      verb: "control",
      description: "查看或设置用户通知偏好（使用哪些渠道接收通知）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["user_id"],
        properties: {
          user_id: { type: "string" },
          channels: {
            type: "array",
            items: { type: "string" },
            description: "设置偏好渠道（不填则只查询）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const userId = String(params.user_id ?? "");
        if (Array.isArray(params.channels)) {
          runtime.notificationRouter?.setPreference(userId, {
            channels: params.channels as string[],
          });
        }
        const pref = runtime.notificationRouter?.getPreference(userId);
        return pref
          ? { status: "ok", ...pref }
          : { status: "not_found", user_id: userId, channels: [], subscriptions: [] };
      },
    },

    {
      id: "notify.bind_subject",
      verb: "control",
      description: "绑定责任人（如：设备 E001 的负责人是张三、李四）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["subject_type", "subject_id", "user_ids"],
        properties: {
          subject_type: {
            type: "string",
            description: "主体类型：equipment / department / role / user",
          },
          subject_id: { type: "string" },
          user_ids: { type: "array", items: { type: "string" } },
        },
      },
      handler: async (_ctx, params) => {
        const subjectType = String(params.subject_type ?? "");
        const subjectId = String(params.subject_id ?? "");
        const userIds = Array.isArray(params.user_ids) ? (params.user_ids as string[]) : [];
        runtime.notificationRouter?.bindSubject(subjectType, subjectId, userIds);
        return {
          status: "ok",
          subject_type: subjectType,
          subject_id: subjectId,
          user_ids: userIds,
        };
      },
    },

    {
      id: "notify.list_bindings",
      verb: "query",
      description: "列出所有责任人绑定关系（subject → userIds）",
      owner: { kind: "core" },
      handler: async () => {
        const bindings = runtime.notificationRouter?.listBindings() ?? [];
        return { bindings, count: bindings.length };
      },
    },

    {
      id: "memory.search",
      verb: "retrieve",
      description:
        "搜索知识库记忆，支持 namespace 过滤（system/operator/user/auto-learned/feedback）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 5 },
          namespace: {
            type: "string",
            enum: ["system", "operator", "user", "auto-learned", "feedback"],
            description: "按 namespace/tag 过滤",
          },
        },
      },
      handler: async (_ctx, params) => {
        const query = String(params.query ?? "");
        const limit = typeof params.limit === "number" ? params.limit : 5;
        const namespace = params.namespace ? String(params.namespace) : undefined;
        const results = await runtime.kb.search(query, { limit, namespace });
        return { results, count: results.length };
      },
    },
  ];
}

// ── L31: 工业能力（已迁移至 claworks-packs/industrial/src/capabilities.ts）─────
//
// 这些能力属于行业业务逻辑，不应存在于 core runtime。
// 保留此函数仅为向后兼容，新代码请通过 industrial pack 的 PackFactory 注册。
// 如需在代码中直接使用，请安装 industrial pack 并通过 runtime.capabilities 调用。
//
// @deprecated 请使用 claworks-packs/industrial pack 代替直接调用此函数

/** @deprecated 工业能力已迁移至 industrial pack，此函数返回空列表。请勿调用。 */
export function makeIndustrialCapabilities(_runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [];
}
// ── L32: system.* 系统管理能力 ────────────────────────────────────────────

export function makeSystemCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "system.reload_packs",
      verb: "control",
      description: "重新加载所有 Pack 配置",
      owner: { kind: "core" },
      handler: async () => {
        try {
          // 发布 reload 事件，playbookEngine 通过 reloadPacks dep 触发重扫
          await runtime.kernel
            .publish("system.packs_reloaded", "system.reload_packs", {
              reloaded_at: new Date().toISOString(),
            })
            .catch(() => undefined);
          // 尝试调用 packLoader 的非标准 reload（如宿主注入了 reload 扩展方法）
          const loaderAny = runtime.packLoader as unknown as { reload?: () => Promise<unknown> };
          if (typeof loaderAny.reload === "function") {
            await loaderAny.reload();
          }
          return { status: "ok", reloaded_at: new Date().toISOString() };
        } catch (err) {
          return { status: "error", reason: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    {
      id: "health.check",
      verb: "query",
      description: "检查系统整体健康状态（DB、LLM、KB、PlaybookEngine、能力注册表）",
      owner: { kind: "core" },
      handler: async () => {
        const components: Record<string, string> = {};
        const startMs = Date.now();

        // 检查 kernel（始终 ok，如果能走到这里）
        components.kernel = "ok";

        // 检查 DB
        try {
          runtime.db.prepare("SELECT 1").get();
          components.db = "ok";
        } catch (err) {
          components.db = `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        // 检查 LLM bridge
        const llmBridge = runtime.bridges?.get(BRIDGE_LLM);
        const llmFn = llmBridge?.complete ?? runtime.llmComplete;
        if (llmFn) {
          components.llm = "configured";
        } else {
          components.llm = "not_configured";
        }

        // 检查 KB
        try {
          const results = await runtime.kb.search("__health_check__", { limit: 1 });
          components.kb = `ok (${Array.isArray(results) ? results.length : 0} results)`;
        } catch (err) {
          components.kb = `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        // 检查 PlaybookEngine
        components.playbook_engine = `${runtime.playbookEngine.list().length} loaded`;

        // 检查 Capabilities
        components.capabilities = `${runtime.capabilities.list().length} registered`;

        // 检查 Packs
        components.packs = `${runtime.loadedPacks.length} loaded`;

        const hasError = Object.values(components).some((v) => v.startsWith("error"));
        const overall = hasError ? "degraded" : "ok";

        return {
          overall,
          components,
          checked_at: new Date().toISOString(),
          check_ms: Date.now() - startMs,
        };
      },
    },

    {
      id: "system.list_skills",
      verb: "query",
      description:
        "列出所有可用的 OpenClaw ClawHub Skill（AI 能力）和 ClaWorks 内置脚本（ScriptLibrary）",
      owner: { kind: "core" },
      handler: async () => {
        const openclawSkills: Array<{ id: string; name: string; type: string; source: string }> =
          [];

        // 获取 OpenClaw skill 列表（通过 skillLibrary bridge）
        const skillLib = (runtime as unknown as { skillLibrary?: { list?: () => unknown[] } })
          .skillLibrary;
        if (typeof skillLib?.list === "function") {
          try {
            const items = skillLib.list();
            for (const s of items) {
              const skill = s as { id?: string; name?: string };
              openclawSkills.push({
                id: skill.id ?? String(s),
                name: skill.name ?? skill.id ?? String(s),
                type: "skill",
                source: "openclaw-clawhub",
              });
            }
          } catch {
            // skill library 不可用时静默
          }
        }

        // 获取 ClaWorks 内置脚本
        const rawScripts = runtime.scriptLibrary?.list() ?? [];
        const claworksScripts = rawScripts.map((s) => ({
          id: s.id,
          name: s.name ?? s.id,
          type: "script",
          source: "claworks-builtin",
        }));

        const all = [...openclawSkills, ...claworksScripts];
        return { items: all, count: all.length };
      },
    },

    {
      id: "system.has_skill",
      verb: "query",
      description: "检查指定的 OpenClaw Skill 或 ClaWorks 内置脚本是否可用",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["skill_id"],
        properties: {
          skill_id: { type: "string", description: "skill 或 script 的 ID" },
        },
      },
      handler: async (_ctx, params) => {
        const skillId = String(params.skill_id ?? "");
        if (!skillId) {
          return { available: false, skill_id: skillId, reason: "skill_id 参数缺失" };
        }
        const result = await runtime.capabilities.invoke(
          "system.list_skills",
          capabilityInvokeCtx(runtime, "system.has_skill"),
          {},
        );
        const items = (result as { items?: Array<{ id: string; name: string }> })?.items ?? [];
        const available = items.some((s) => s.id === skillId || s.name === skillId);
        return { available, skill_id: skillId };
      },
    },

    {
      id: "system.self_test",
      verb: "execute",
      description: "使用强模型自动检查机器人各项核心能力（感知/执行/记忆/学习），返回能力评估报告",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "检查范围：all/perceive/memory/execute/learn（默认 all）",
          },
          model: { type: "string", description: "使用的模型（默认当前 llmComplete）" },
        },
      },
      handler: async (_ctx, params) => {
        const scope = String(params.scope ?? "all");
        const results: Record<string, unknown> = {};

        const llmBridge = runtime.bridges?.get(BRIDGE_LLM);
        const llmFn = llmBridge?.complete ?? runtime.llmComplete;
        if (!llmFn) {
          return { status: "error", reason: "llmComplete 未配置，无法进行自检" };
        }

        // 1. 感知能力自检：调用 perceive.intent 测试意图分类
        if (scope === "all" || scope === "perceive") {
          try {
            const r = await runtime.capabilities.invoke(
              "perceive.intent",
              capabilityInvokeCtx(runtime, "system.self_test"),
              { text: "泵1号振动超标，需要处理" },
            );
            const intent = (r as Record<string, unknown>).intent as string | undefined;
            results.perceive_intent = {
              status: intent && intent !== "unknown" ? "ok" : "degraded",
              intent,
              confidence: (r as Record<string, unknown>).confidence,
            };
          } catch (e) {
            results.perceive_intent = { status: "error", reason: String(e) };
          }
        }

        // 2. 记忆能力自检：测试 KB 写入和检索
        if (scope === "all" || scope === "memory") {
          try {
            const testContent = `自检测试内容_${Date.now()}`;
            await runtime.kb.ingest(testContent, { source: "self_test" });
            const hits = await runtime.kb.search("自检测试", { limit: 1 });
            results.memory_kb = {
              status: hits.length > 0 ? "ok" : "degraded",
              ingest_ok: true,
              search_hit: hits.length > 0,
            };
          } catch (e) {
            results.memory_kb = { status: "error", reason: String(e) };
          }
        }

        // 3. 执行能力自检：验证 capability registry 和 Playbook 数量
        if (scope === "all" || scope === "execute") {
          const capCount = runtime.capabilities?.list().length ?? 0;
          const pbCount = runtime.playbookEngine?.list().length ?? 0;
          results.execute_capabilities = {
            status: capCount > 100 ? "ok" : "degraded",
            capability_count: capCount,
            playbook_count: pbCount,
          };
        }

        // 4. 学习能力自检：验证 CBR 和 EvolveEngine
        if (scope === "all" || scope === "learn") {
          results.learn_cbr = {
            status: runtime.cbrStore ? "ok" : "not_configured",
            cbr_available: !!runtime.cbrStore,
            evolution_available: !!runtime.evolutionSync,
          };
        }

        const allOk = Object.values(results).every(
          (r) => (r as Record<string, unknown>).status === "ok",
        );
        return {
          status: allOk ? "healthy" : "degraded",
          scope,
          checks: results,
          checked_at: new Date().toISOString(),
        };
      },
    },
  ];
}

// ── L33: skill.* / script.* ──────────────────────────────────────────────
//
// 命名约定（与 OpenClaw 对齐）：
//   script.*  → ClaWorks 内置纯 TS 脚本（ScriptLibrary，不依赖 LLM）
//   skill.*   → OpenClaw ClawHub 能力（SKILL.md 驱动的 AI 推理，通过 runEmbeddedAgent）
//
// Playbook YAML 中：
//   kind: script  → 调用内置脚本（script.execute）
//   kind: skill   → 调用 OpenClaw embedded agent（skill.run）

export function makeSkillCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    // ── script.* ─────────────────────────────────────────────────────────
    {
      id: "script.execute",
      verb: "execute",
      description:
        "执行 ClaWorks 内置脚本（纯代码，完全不依赖 LLM）。Playbook kind:script 步骤可调用。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["script_id"],
        properties: {
          script_id: { type: "string", description: "脚本 ID，如 kb.quick_search" },
        },
      },
      handler: async (_ctx, params) => {
        const scriptId = String(params.script_id ?? "");
        if (!scriptId) {
          return { status: "error", reason: "script_id 参数缺失" };
        }
        const script = runtime.scriptLibrary?.get(scriptId);
        if (!script) {
          return { status: "not_found", script_id: scriptId };
        }
        const { script_id: _, ...scriptParams } = params;
        try {
          const result = await runtime.scriptLibrary?.invoke(
            scriptId,
            scriptParams as Record<string, unknown>,
          );
          return { status: "ok", ...(result as Record<string, unknown>) };
        } catch (err) {
          return {
            status: "error",
            script_id: scriptId,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      id: "script.list",
      verb: "query",
      description: "列出所有已注册的内置脚本（ClaWorks ScriptLibrary）",
      owner: { kind: "core" },
      handler: async () => {
        const raw = runtime.scriptLibrary?.list() ?? [];
        const scripts = raw.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        }));
        return { scripts, count: scripts.length };
      },
    },

    // ── script.run（script.execute 别名，对齐 OpenClaw skill.run 命名风格）
    {
      id: "script.run",
      verb: "execute",
      description:
        "运行 ClaWorks 内置纯代码辅助脚本（无 LLM）。与 skill.run 不同，调用的是确定性 TypeScript 函数。script.execute 的别名。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["script_id"],
        properties: {
          script_id: { type: "string" },
          function: { type: "string", description: "可选：脚本内子函数名" },
        },
        additionalProperties: true,
      },
      handler: async (_ctx, params) => {
        const scriptId = String(params.script_id ?? "");
        if (!scriptId) return { status: "error", reason: "script_id 参数缺失" };
        const script = runtime.scriptLibrary?.get(scriptId);
        if (!script) return { status: "not_found", script_id: scriptId };
        const { script_id: _, function: _fn, ...rest } = params;
        try {
          const result = await runtime.scriptLibrary?.invoke(scriptId, rest);
          return { status: "ok", ...(result as Record<string, unknown>) };
        } catch (err) {
          return {
            status: "error",
            script_id: scriptId,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },

    // ── skill.* ──────────────────────────────────────────────────────────
    // @deprecated skill.execute — 向后兼容别名（指向 scriptLibrary，不是 OpenClaw skill）
    {
      id: "skill.execute",
      verb: "execute",
      description: "@deprecated 使用 script.execute；执行 ClaWorks 内置脚本（向后兼容别名）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["skill_id"],
        properties: {
          skill_id: { type: "string", description: "脚本 ID" },
        },
      },
      handler: async (_ctx, params) => {
        // 委托给 script.execute，仅做参数键名映射（skill_id → script_id）
        const { skill_id, ...rest } = params;
        const scriptId = String(skill_id ?? "");
        if (!scriptId) return { status: "error", reason: "skill_id 参数缺失" };
        const script = runtime.scriptLibrary?.get(scriptId);
        if (!script) return { status: "not_found", skill_id: scriptId };
        try {
          const result = await runtime.scriptLibrary?.invoke(
            scriptId,
            rest as Record<string, unknown>,
          );
          return { status: "ok", ...(result as Record<string, unknown>) };
        } catch (err) {
          return {
            status: "error",
            skill_id: scriptId,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      id: "skill.list",
      verb: "query",
      description:
        "列出所有可用 skill：本地 Pack 脚本 + OpenClaw harness skill（如已连接）。" +
        "@deprecated 本地脚本部分请使用 script.list。",
      owner: { kind: "core" },
      handler: async () => {
        // 本地脚本
        const localRaw = runtime.scriptLibrary?.list() ?? [];
        const localSkills = localRaw.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          source: "local" as const,
        }));

        // OpenClaw harness skill list（via BRIDGE_SKILL）
        let harnessSkills: Array<{
          id: string;
          name: string;
          description: string;
          source: "harness";
        }> = [];
        const skillBridge = runtime.bridges?.get(BRIDGE_SKILL);
        if (skillBridge?.list) {
          try {
            const raw = await skillBridge.list();
            harnessSkills = raw.map((s) => ({
              id: s.id,
              name: s.name ?? s.id,
              description: s.description ?? "",
              source: "harness" as const,
            }));
          } catch {
            // harness 不可用时静默降级
          }
        }
        if (harnessSkills.length === 0) {
          try {
            const raw = await discoverHarnessSkillsFromConfig();
            harnessSkills = raw.map((s) => ({
              id: s.id,
              name: s.name ?? s.id,
              description: s.description ?? "",
              source: "harness" as const,
            }));
          } catch {
            // OpenClaw 配置扫描失败时静默降级
          }
        }

        const skills = [...localSkills, ...harnessSkills];
        return {
          skills,
          count: skills.length,
          local_count: localSkills.length,
          harness_count: harnessSkills.length,
        };
      },
    },

    // ── skill.run ─────────────────────────────────────────────────────────
    // 统一 Skill 入口：先查本地 scriptLibrary，找不到再走 OpenClaw harness。
    // Playbook 中也可直接用 kind: skill（step-executor 直接调用 deps.skillRun）；
    // 此能力供 action 步骤（kind: action, action: "skill.run"）使用。
    {
      id: "skill.run",
      verb: "execute",
      description:
        "统一 Skill 执行入口：优先调用本地 Pack 脚本，未找到时代理到 OpenClaw ClawHub Skill（runEmbeddedAgent）。" +
        "与 script.execute 不同，这里走 fallthrough 统一注册池。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["skill_id"],
        properties: {
          skill_id: {
            type: "string",
            description: "Skill ID（本地脚本或 OpenClaw ClawHub Skill ID）",
          },
          input: { type: "object", description: "传入 skill 的输入参数（可选）" },
        },
      },
      handler: async (_ctx, params) => {
        const SKILL_TIMEOUT_MS = 180_000;
        const skillId = String(params.skill_id ?? "");
        if (!skillId) {
          return { status: "error", reason: "skill_id 参数缺失" };
        }

        // 1. 先查本地 scriptLibrary（Pack 贡献的确定性脚本）
        const localScript = runtime.scriptLibrary?.get(skillId);
        if (localScript) {
          const { skill_id: _, input: _input, ...rest } = params;
          const mergedInput = { ...((params.input as Record<string, unknown>) ?? {}), ...rest };
          try {
            const result = await runtime.scriptLibrary?.invoke(skillId, mergedInput);
            return {
              status: "ok",
              skill_id: skillId,
              source: "local",
              ...(result as Record<string, unknown>),
            };
          } catch (err) {
            return {
              status: "error",
              skill_id: skillId,
              source: "local",
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        }

        // 2. 本地未找到，fallthrough 到 OpenClaw harness（BRIDGE_SKILL 优先，兼容 runtime.skillRun）
        const skillBridge = runtime.bridges?.get(BRIDGE_SKILL);
        const skillRunFn = skillBridge
          ? (args: { skillId: string; input: Record<string, unknown> }) => skillBridge.run(args)
          : runtime.skillRun;
        if (!skillRunFn) {
          return {
            status: "not_found",
            skill_id: skillId,
            reason: "本地未找到该 skill，且 OpenClaw skill bridge 未连接（skillRun 未注入）",
          };
        }
        try {
          const input = (params.input as Record<string, unknown>) ?? {};
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`skill.run timeout after ${SKILL_TIMEOUT_MS}ms`)),
              SKILL_TIMEOUT_MS,
            ),
          );
          const result = await Promise.race([skillRunFn({ skillId, input }), timeoutPromise]);
          return {
            status: "ok",
            skill_id: skillId,
            source: "harness",
            ...(result as Record<string, unknown>),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("timeout")) {
            return { status: "timeout", skill_id: skillId, error: msg };
          }
          return { status: "error", skill_id: skillId, reason: msg };
        }
      },
    },
  ];
}

// ── L34: rule.* ──────────────────────────────────────────────────────────

export function makeRuleCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "rule.evaluate",
      verb: "query",
      description:
        "执行决策表，对上下文数据匹配 if-then 规则，完全不依赖 LLM。弱模型补偿核心能力。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["table_id", "context"],
        properties: {
          table_id: { type: "string", description: "决策表 ID" },
          context: { type: "object", description: "待匹配的上下文数据" },
        },
      },
      handler: async (_ctx, params) => {
        const tableId = String(params.table_id ?? "");
        const context = (params.context as Record<string, unknown>) ?? {};
        if (!tableId) {
          return { status: "error", reason: "table_id 参数缺失" };
        }
        try {
          const summary = await runtime.ruleEngine?.evaluate(tableId, context);
          return { status: "ok", ...summary };
        } catch (err) {
          return {
            status: "error",
            table_id: tableId,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      id: "rule.register",
      verb: "execute",
      description: "动态注册一张决策表（Pack 可在启动时注册自定义规则）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["table"],
        properties: {
          table: { type: "object", description: "DecisionTable 对象" },
        },
      },
      handler: async (_ctx, params) => {
        const table = params.table as import("./rule-engine.js").DecisionTable | undefined;
        if (!table?.id || !table.name || !Array.isArray(table.rules)) {
          return { status: "error", reason: "table 参数无效：需要 id, name, rules[]" };
        }
        const re = runtime.ruleEngine as { registerTable?: (t: unknown) => void } | undefined;
        re?.registerTable?.(table);
        return { status: "ok", table_id: table.id, rules_count: table.rules.length };
      },
    },
    {
      id: "rule.list",
      verb: "query",
      description: "列出所有已注册的决策表",
      owner: { kind: "core" },
      handler: async () => {
        const reList = runtime.ruleEngine as
          | {
              listTables?: () => Array<{
                id: string;
                name?: string;
                description?: string;
                rules: unknown[];
              }>;
            }
          | undefined;
        const tables =
          reList?.listTables?.()?.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            rules_count: t.rules.length,
          })) ?? [];
        return { tables, count: tables.length };
      },
    },
  ];
}

// ── L35: 治理增强（audit.* + governance.*）────────────────────────────────

export function makeGovernanceCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "audit.query",
      verb: "retrieve",
      description: "查询审计日志（按 capability_id / 时间范围 / actor 过滤）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          capability_id: { type: "string", description: "能力 ID 过滤（支持前缀匹配）" },
          since_hours: { type: "number", default: 24, description: "过去 N 小时内" },
          actor: { type: "string", description: "触发者 ID 过滤" },
          limit: { type: "integer", default: 50 },
        },
      },
      handler: async (_ctx, params) => {
        const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;
        const limit = typeof params.limit === "number" ? params.limit : 50;
        const capabilityId = params.capability_id ? String(params.capability_id) : undefined;
        const actor = params.actor ? String(params.actor) : undefined;

        const events = await runtime.kernel.bus.query({
          from: new Date(Date.now() - sinceHours * 3_600_000),
          limit: limit * 3,
        });

        let filtered = events.filter(
          (e) =>
            e.type.startsWith("capability.") ||
            e.type.startsWith("audit.") ||
            e.type.startsWith("constitution.") ||
            e.type.startsWith("hitl."),
        );

        if (capabilityId) {
          filtered = filtered.filter((e) => {
            const p = e.payload;
            return String(p.capability_id ?? p.id ?? "").startsWith(capabilityId);
          });
        }

        if (actor) {
          filtered = filtered.filter((e) => {
            const p = e.payload;
            return String(p.actor ?? p.source ?? e.source ?? "").includes(actor);
          });
        }

        return {
          results: filtered.slice(0, limit).map((e) => ({
            id: e.id,
            type: e.type,
            source: e.source,
            timestamp: e.timestamp,
            payload: e.payload,
          })),
          count: filtered.length,
          since_hours: sinceHours,
        };
      },
    },

    {
      id: "governance.circuit_breaker_status",
      verb: "query",
      description: "查看所有能力熔断器状态（open/half-open/closed），运维排查用",
      owner: { kind: "core" },
      handler: async () => {
        const breakers = runtime.capabilities.listCircuitBreakers?.() ?? [];
        const now = Date.now();
        const active = breakers.filter((b) => b.state !== "closed");
        return {
          circuit_breakers: breakers,
          active_count: active.length,
          open: active
            .filter((b) => b.state === "open")
            .map((b) => ({
              ...b,
              reopens_in_ms: b.openUntil ? Math.max(0, b.openUntil - now) : 0,
            })),
          half_open: active.filter((b) => b.state === "half-open"),
        };
      },
    },

    {
      id: "governance.reset_circuit_breaker",
      verb: "control",
      description: "手动重置某个能力的熔断器（运维用途，需要 HITL）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "重置熔断器是运维操作，需要确认" },
      paramsSchema: {
        type: "object",
        required: ["capability_id"],
        properties: {
          capability_id: { type: "string", description: "要重置的能力 ID" },
        },
      },
      handler: async (_ctx, params) => {
        const id = String(params.capability_id ?? "");
        runtime.capabilities.resetCircuitBreaker?.(id);
        return { status: "ok", capability_id: id, message: `熔断器已重置` };
      },
    },
  ];
}

// ── 工厂：一次性注册所有扩展能力 ─────────────────────────────────────────

export function registerExtensionCapabilities(
  runtime: ClaworksRuntime,
  constitution: ConstitutionV2,
): void {
  const all: CapabilityDescriptor[] = [
    ...makeReasoningCapabilities(runtime), // L10
    ...makeMemoryCapabilities(runtime), // L11
    ...makeMemoryKvCapabilities(runtime), // L11b: memory.store / memory.get
    ...makeCommsCapabilities(runtime), // L12
    ...makeA2aCapabilities(runtime), // L13
    ...makePackCapabilities(runtime), // L14
    ...makeConnectorCapabilities(runtime), // L15
    ...makeScheduleCapabilities(runtime), // L16
    ...makeMonitorCapabilities(runtime), // L17
    ...makeNexusCapabilities(runtime), // L18
    ...makeGuideCapabilities(runtime), // L19
    ...makeConstitutionCapabilities(runtime, constitution), // L20
    ...makeContextCapabilities(runtime), // L21
    ...makeCbrCapabilities(runtime), // L22
    ...makeHookCapabilities(runtime), // L23
    ...makeProviderCapabilities(runtime), // L24
    ...makeTaskManagementCapabilities(runtime), // L25
    ...makeReportCapabilities(runtime), // L26
    ...makeApprovalCapabilities(runtime), // L27
    ...makeWorkOrderCapabilities(runtime), // L28
    ...makeAlarmCapabilities(runtime), // L29
    ...makeNotifyCapabilities(runtime), // L30
    // L31（工业能力）已迁移至 claworks-packs/industrial/src/capabilities.ts
    // shift.*, incident.*, equipment.*, maintenance.*, production.*, safety.*
    // 由 PackLoader 在加载 industrial pack 时注册，不在 core 中注册
    ...makeSystemCapabilities(runtime), // L32
    ...makeSkillCapabilities(runtime), // L33
    ...makeRuleCapabilities(runtime), // L34
    ...makeGovernanceCapabilities(runtime), // L35
    ...makeSecurityCapabilities(runtime), // L36
    ...makeScaffoldCapabilities(runtime), // L37
    ...makeLearningCapabilities(runtime), // L38
    ...makeEvolveCapabilities(runtime), // L39
    ...makeResearchCapabilities(runtime), // L40
    ...makeAgentOrchCapabilities(runtime), // L41
    ...makeEvolutionSyncCapabilities(runtime), // L42: 离线进化同步管道
    ...makeVisionCapabilities(runtime), // L43: vision.*
  ];

  runtime.capabilities.registerAll(all);
}

// ── L42: evolution.* (离线进化同步管道) ──────────────────────────────────

export function makeEvolutionSyncCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "evolution.export_data",
      verb: "acquire",
      description: "导出机器人进化数据包（脱敏后可安全传输，供离线强模型生成改进包）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          days: {
            type: "integer",
            default: 30,
            description: "收集最近多少天的数据（默认 30 天）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const mgr = runtime.evolutionSync;
        if (!mgr) {
          return { status: "unavailable", reason: "evolutionSync 管理器未初始化" };
        }
        const days = typeof params.days === "number" ? params.days : 30;
        const data = await mgr.exportEvolutionData(days);
        return data as unknown as Record<string, unknown>;
      },
    },

    {
      id: "evolution.import_pack",
      verb: "execute",
      description: "导入进化包（由外部商业模型生成，热更新 Playbook/规则/提示词/KB）",
      owner: { kind: "core" },
      rbac: { decision: "hitl_required", reason: "导入进化包会修改机器人行为" },
      paramsSchema: {
        type: "object",
        required: ["pack"],
        properties: {
          pack: { type: "object", description: "EvolutionPack JSON 对象" },
        },
      },
      handler: async (_ctx, params) => {
        const mgr = runtime.evolutionSync;
        if (!mgr) {
          return { status: "unavailable", reason: "evolutionSync 管理器未初始化" };
        }
        const pack = params.pack as import("./evolution-sync.js").EvolutionPack;
        if (!pack?.version) {
          return { status: "error", reason: "pack 参数无效或缺少 version 字段" };
        }
        const result = await mgr.importEvolutionPack(pack);
        return result as unknown as Record<string, unknown>;
      },
    },

    {
      id: "evolution.status",
      verb: "query",
      description: "查看进化同步历史（最近导入了哪些进化包，有多少改进已应用）",
      owner: { kind: "core" },
      handler: async () => {
        const mgr = runtime.evolutionSync;
        if (!mgr) {
          return { status: "unavailable", history: [], total_imported: 0 };
        }
        const status = mgr.getStatus();
        const history = mgr.getHistory().slice(0, 10);
        return { ...status, history };
      },
    },
  ];
}

// ── L36: security.* 安全审计能力 ─────────────────────────────────────────

export function makeSecurityCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "security.audit_log",
      verb: "query",
      description: "查询安全审计日志（RBAC 拒绝、认证失败等事件）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 50 },
          event_type: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const limit = typeof params.limit === "number" ? params.limit : 50;
        const eventTypeFilter = params.event_type ? String(params.event_type) : undefined;
        try {
          // Merge events from cw_audit_log (explicit audit writes) and cw_events (security events)
          const auditRows = (() => {
            try {
              const filterSql = eventTypeFilter ? " AND event_type LIKE ?" : "";
              return runtime.db
                .prepare(
                  `SELECT id, event_type AS type, actor AS source, target, payload, created_at AS ts FROM cw_audit_log WHERE 1=1${filterSql} ORDER BY id DESC LIMIT ?`,
                )
                .all(...(eventTypeFilter ? [`%${eventTypeFilter}%`, limit] : [limit])) as Array<{
                id: number;
                type: string;
                source: string | null;
                target: string | null;
                payload: string | null;
                ts: string;
              }>;
            } catch {
              return [];
            }
          })();

          const secEventRows = runtime.db
            .prepare(
              "SELECT id, type, source, payload, timestamp FROM cw_events WHERE (type LIKE 'rbac.%' OR type LIKE 'security.%' OR type LIKE 'auth.%') ORDER BY timestamp DESC LIMIT ?",
            )
            .all(limit) as Array<{
            id: string;
            type: string;
            source: string;
            payload: string;
            timestamp: number;
          }>;

          const auditEntries = auditRows.map((r) => ({
            id: String(r.id),
            type: r.type,
            source: r.source ?? "system",
            target: r.target ?? undefined,
            payload: (() => {
              try {
                return r.payload ? JSON.parse(r.payload) : {};
              } catch {
                return r.payload;
              }
            })(),
            timestamp: r.ts,
            table: "cw_audit_log",
          }));

          const secEntries = secEventRows.map((r) => ({
            id: r.id,
            type: r.type,
            source: r.source,
            payload: (() => {
              try {
                return JSON.parse(r.payload);
              } catch {
                return r.payload;
              }
            })(),
            timestamp: new Date(r.timestamp).toISOString(),
            table: "cw_events",
          }));

          const all = [...auditEntries, ...secEntries].slice(0, limit);
          return { events: all, count: all.length };
        } catch {
          return { events: [], count: 0, note: "audit table query failed" };
        }
      },
    },

    {
      id: "security.api_key_status",
      verb: "query",
      description: "查询 API Key 配置状态（不返回实际 Key）",
      owner: { kind: "core" },
      handler: async () => {
        const primaryKey = runtime.config.api?.api_key?.trim();
        const extraKeys = (runtime.config.api?.api_keys ?? []).filter((k) => k?.trim());
        const totalConfigured = (primaryKey ? 1 : 0) + extraKeys.length;
        const required =
          runtime.config.api?.require_api_key === true ||
          runtime.config.security?.require_api_key === true ||
          process.env.CLAWORKS_REQUIRE_API_KEY === "1";
        const envKeySet = !!process.env.CLAWORKS_API_KEY?.trim();
        return {
          api_key_configured: totalConfigured > 0 || envKeySet,
          api_key_required: required,
          source: envKeySet ? "env" : totalConfigured > 0 ? "config" : "none",
          key_count: totalConfigured + (envKeySet ? 1 : 0),
        };
      },
    },

    {
      id: "security.rate_limit_status",
      verb: "query",
      description: "查询当前速率限制配置与状态",
      owner: { kind: "core" },
      handler: async () => {
        const rl = (runtime as unknown as { rateLimiter?: { size: () => number } }).rateLimiter;
        const maxRequests =
          (process.env.CLAWORKS_RATE_LIMIT_PER_MIN
            ? Number.parseInt(process.env.CLAWORKS_RATE_LIMIT_PER_MIN, 10)
            : undefined) ??
          runtime.config.kernel?.rate_limit_max_requests ??
          120;
        return {
          max_requests_per_minute: maxRequests,
          window_ms: runtime.config.kernel?.rate_limit_window_ms ?? 60_000,
          active_buckets: rl?.size?.() ?? 0,
          env_override: !!process.env.CLAWORKS_RATE_LIMIT_PER_MIN,
        };
      },
    },

    // ── L9: observe.* ────────────────────────────────────────────────────
    // 可观测性能力：让 OpenClaw/Claude 能实时看到机器人内部运行状态

    {
      id: "observe.playbook_runs",
      verb: "query",
      description: "查看当前正在运行（或最近完成）的 Playbook 列表",
      owner: { kind: "core" },
      handler: async () => {
        const runs = await runtime.playbookEngine.listRuns({ limit: 50 });
        const active = runs.filter((r) => r.status === "running" || r.status === "waiting_hitl");
        return {
          count: active.length,
          runs: active.map((r) => ({
            id: r.id,
            playbook: r.playbookId,
            status: r.status,
            started_at: r.startedAt,
            elapsed_ms: Date.now() - new Date(r.startedAt).getTime(),
          })),
        };
      },
    },

    {
      id: "observe.event_log",
      verb: "query",
      description: "查看最近发布到 EventKernel 的事件日志（环形缓冲，最多 200 条）",
      owner: { kind: "core" },
      handler: async (_ctx, params) => {
        const limit = typeof params?.limit === "number" ? params.limit : 20;
        const eventType = params?.event_type ? String(params.event_type) : undefined;
        const log = runtime.kernel.getRecentEvents(limit, eventType);
        return {
          count: log.length,
          events: log.map((e) => ({
            type: e.type,
            source: e.source,
            ts: e.ts.toISOString(),
          })),
        };
      },
    },

    {
      id: "observe.capability_stats",
      verb: "query",
      description: "统计最近能力调用次数（从 EventKernel 环形缓冲提取 capability.called.* 事件）",
      owner: { kind: "core" },
      handler: async () => {
        const recentEvents = runtime.kernel.getRecentEvents(200);
        const stats: Record<string, { calls: number; last_called?: string }> = {};
        for (const e of recentEvents) {
          if (e.type.startsWith("capability.called.")) {
            const capId = e.type.slice("capability.called.".length);
            if (!stats[capId]) {
              stats[capId] = { calls: 0 };
            }
            stats[capId].calls++;
            stats[capId].last_called = e.ts.toISOString();
          }
        }
        return {
          stats,
          total_recent_events: recentEvents.length,
          period: "最近 200 个事件",
          tracked_capabilities: Object.keys(stats).length,
        };
      },
    },

    {
      id: "observe.robot_status",
      verb: "query",
      description: "获取机器人整体运行状态：健康度、活跃任务数、知识库规模、已注册能力数、上线时长",
      owner: { kind: "core" },
      handler: async (ctx) => {
        const [healthResult, kbStatusResult, runsResult] = await Promise.allSettled([
          runtime.capabilities.invoke("health.check", ctx, {}),
          runtime.capabilities.invoke("kb.status", ctx, {}),
          runtime.capabilities.invoke("observe.playbook_runs", ctx, {}),
        ]);

        const health = healthResult.status === "fulfilled" ? healthResult.value : {};
        const kbStatus = kbStatusResult.status === "fulfilled" ? kbStatusResult.value : {};
        const runs = runsResult.status === "fulfilled" ? runsResult.value : { count: 0 };

        const runtimeAny = runtime as unknown as { startTime?: number };
        const uptimeSeconds = runtimeAny.startTime
          ? Math.floor((Date.now() - runtimeAny.startTime) / 1000)
          : 0;

        return {
          robot_name: runtime.identity?.name ?? "ClaWorks",
          robot_id: (runtime.robot as unknown as { id?: string })?.id ?? "unknown",
          uptime_seconds: uptimeSeconds,
          health: health.overall ?? "unknown",
          active_playbooks: runs.count ?? 0,
          kb_entries: kbStatus.entry_count ?? 0,
          capabilities_registered: runtime.capabilities.list().length,
          loaded_packs: runtime.loadedPacks.length,
        };
      },
    },

    {
      id: "observe.audit_log",
      verb: "execute",
      description:
        "将操作事件写入 cw_audit_log 审计表（actor、target、event_type、payload）。" +
        "用于 Playbook 步骤记录业务操作审计轨迹，可通过 security.audit_log 查询。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["event_type"],
        properties: {
          event_type: { type: "string", description: "审计事件类型，如 approval.granted" },
          actor: { type: "string", description: "操作人 ID 或系统标识" },
          target: { type: "string", description: "被操作对象 ID" },
          payload: { type: "object", description: "附加上下文数据" },
        },
      },
      handler: async (_ctx, params) => {
        const eventType = String(params.event_type ?? "");
        const actor = params.actor ? String(params.actor) : null;
        const target = params.target ? String(params.target) : null;
        const payload = params.payload ? JSON.stringify(params.payload) : null;
        try {
          runtime.db
            .prepare(
              "INSERT INTO cw_audit_log (event_type, actor, target, payload) VALUES (?, ?, ?, ?)",
            )
            .run(eventType, actor, target, payload);
          return { recorded: true, event_type: eventType };
        } catch (err) {
          // Table may not exist on older DB schemas — ensure it exists then retry
          try {
            runtime.db.exec(`
              CREATE TABLE IF NOT EXISTS cw_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                actor TEXT,
                target TEXT,
                payload TEXT,
                created_at TEXT DEFAULT (datetime('now'))
              )
            `);
            runtime.db
              .prepare(
                "INSERT INTO cw_audit_log (event_type, actor, target, payload) VALUES (?, ?, ?, ?)",
              )
              .run(eventType, actor, target, payload);
            return { recorded: true, event_type: eventType };
          } catch (retryErr) {
            return {
              recorded: false,
              reason: retryErr instanceof Error ? retryErr.message : String(retryErr),
            };
          }
        }
      },
    },
    {
      // observe.set_variable: 在 Playbook 中以能力调用形式设置一个变量
      // 配合 store_result_as 使用；返回值即为要写入的变量内容
      id: "observe.set_variable",
      verb: "execute",
      description: "设置 Playbook 上下文变量（配合 store_result_as 使用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["name", "value"],
        properties: {
          name: { type: "string", description: "变量名" },
          value: { description: "变量值（任意类型）" },
        },
      },
      handler: async (_ctx, params) => {
        const name = String(params.name ?? "");
        const value = params.value;
        // 返回 { [name]: value } 以便 store_result_as 或直接引用
        return { [name]: value, value, _var_name: name };
      },
    },
    {
      // hitl.request: 非暂停式 HITL 触发——发布 hitl.requested 事件并返回 token
      // 适合在 action step 中发起审批通知；若需等待响应请改用 kind: hitl 步骤
      id: "hitl.request",
      verb: "execute",
      description: "发起 HITL 审批请求（发布事件，不暂停 Playbook）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          context: { description: "审批上下文（任意对象）" },
          timeout_hours: { type: "number" },
        },
      },
      handler: async (ctx, params) => {
        const token = `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        await runtime.kernel.publish("hitl.requested", "hitl.request", {
          token,
          prompt: String(params.prompt ?? ""),
          context: params.context,
          timeout_hours: params.timeout_hours ?? 24,
          run_id: ctx.runId ?? ctx.stepCtx?.runId,
          playbook_id: ctx.playbookId ?? ctx.stepCtx?.playbookId,
        });
        return { token, status: "pending", prompt: params.prompt };
      },
    },
    {
      id: "incident.create",
      verb: "execute",
      description: "创建安全事故/事件记录（ObjectStore Incident 对象）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string" },
          location: { type: "string" },
          reporter_id: { type: "string" },
        },
      },
      handler: async (_ctx, params) => {
        const id = `incident-${Date.now()}`;
        await runtime.objectStore.create("Incident", {
          id,
          title: String(params.title ?? ""),
          description: String(params.description ?? ""),
          severity: String(params.severity ?? "medium"),
          location: String(params.location ?? ""),
          reporter_id: String(params.reporter_id ?? ""),
          status: "open",
          created_at: new Date().toISOString(),
        });
        await runtime.kernel.publish("incident.created", "incident.create", {
          incident_id: id,
          title: params.title,
          severity: params.severity,
        });
        return { incident_id: id, status: "created" };
      },
    },
    {
      id: "maintenance.list",
      verb: "acquire",
      description: "查询维护工单列表（可按状态/设备过滤）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "工单状态过滤（如 pending/overdue）" },
          equipment_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (_ctx, params) => {
        const filter: Record<string, unknown> = {};
        if (params.status) filter.status = String(params.status);
        if (params.equipment_id) filter.equipment_id = String(params.equipment_id);
        const result = await runtime.objectStore.query("MaintenanceOrder", {
          filter,
          limit: typeof params.limit === "number" ? params.limit : 20,
        });
        return { items: result.items, count: result.items.length };
      },
    },
  ];
}

// ── L37: scaffold.* 弱模型脚手架能力 ─────────────────────────────────────
//
// 核心思想：强模型（离线/初始化时）预生成 Prompt/DecisionTable/Skill，
// 弱模型（在线/实时时）只需填空+规则匹配，无需自由推理。

/** llm.scaffold 核心执行逻辑（从 handler 提取以控制行数）*/
async function runScaffold(
  runtime: ClaworksRuntime,
  scaffoldId: string,
  variables: Record<string, unknown>,
  extraContext: string,
  requireJson: boolean,
): Promise<Record<string, unknown>> {
  const engine = runtime.scaffoldEngine;
  if (!engine) return { success: false, error: "ScaffoldEngine 未初始化", text: "" };

  const asset = engine.get(scaffoldId);
  if (!asset) {
    // 降级：尝试 promptRegistry
    if (runtime.promptRegistry) {
      const rendered = runtime.promptRegistry.render(scaffoldId, variables);
      if (rendered) {
        const llmFn = runtime.llmComplete ?? runtime.bridges?.get(BRIDGE_LLM)?.complete;
        if (!llmFn)
          return { success: false, error: "LLM 未配置", text: "", scaffold_id: scaffoldId };
        try {
          const res = await llmFn({ prompt: rendered });
          return { text: res.text, success: true, scaffold_id: scaffoldId };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            text: "",
          };
        }
      }
    }
    return {
      success: false,
      error: `scaffold not found: ${scaffoldId}`,
      text: "",
      scaffold_id: scaffoldId,
    };
  }

  // 解析 scaffold 内容（支持工业 JSON 格式与 ScaffoldAsset 两种结构）
  let scaffoldData: Record<string, unknown> = {};
  try {
    scaffoldData = JSON.parse(asset.content) as Record<string, unknown>;
  } catch {
    /* empty */
  }

  let promptTemplate = String(scaffoldData.prompt_template ?? scaffoldData.user_template ?? "");
  const systemPrompt = String(scaffoldData.system ?? scaffoldData.system_prompt ?? "");
  const examples = Array.isArray(scaffoldData.examples) ? scaffoldData.examples : [];
  const outputSchema = scaffoldData.output_schema ?? scaffoldData.outputSchema;

  // 替换占位符（同时支持 {var} 和 {{var}} 两种语法）
  for (const [key, value] of Object.entries(variables)) {
    const strVal = String(value ?? "");
    promptTemplate = promptTemplate
      .replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), strVal)
      .replace(new RegExp(`\\{${key}\\}`, "g"), strVal);
  }
  if (extraContext) promptTemplate = `${extraContext}\n\n${promptTemplate}`;

  // 构建系统提示词 + few-shot 示例
  let fullSystem = systemPrompt;
  if (examples.length > 0) {
    fullSystem += "\n\n示例：\n";
    for (const ex of (examples as Array<{ input: unknown; output: unknown }>).slice(0, 3)) {
      fullSystem += `输入：${JSON.stringify(ex.input)}\n输出：${JSON.stringify(ex.output)}\n\n`;
    }
  }
  const fullPrompt = fullSystem ? `${fullSystem}\n\n${promptTemplate}` : promptTemplate;

  // 有 outputSchema 或要求 JSON → 使用结构化输出引擎
  if ((requireJson || outputSchema) && runtime.structuredOutput && outputSchema) {
    try {
      const result = await runtime.structuredOutput.complete(
        fullPrompt,
        outputSchema as import("./structured-output.js").OutputSchema,
        { maxRetries: 2, fallback: {} },
      );
      engine.recordUsage(scaffoldId, !result.fallback);
      return { ...result.data, success: true, fallback: result.fallback, scaffold_id: scaffoldId };
    } catch (err) {
      engine.recordUsage(scaffoldId, false);
      return { success: false, error: err instanceof Error ? err.message : String(err), text: "" };
    }
  }

  // 普通文本生成
  const llmFn = runtime.llmComplete ?? runtime.bridges?.get(BRIDGE_LLM)?.complete;
  if (!llmFn) return { success: false, error: "LLM 未配置", text: "", scaffold_id: scaffoldId };
  try {
    const res = await llmFn({ prompt: fullPrompt });
    engine.recordUsage(scaffoldId, true);
    return { text: res.text, success: true, scaffold_id: scaffoldId };
  } catch (err) {
    engine.recordUsage(scaffoldId, false);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      text: "",
      scaffold_id: scaffoldId,
    };
  }
}

export function makeScaffoldCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "scaffold.generate_domain",
      verb: "execute",
      description:
        "调用强模型为指定领域预生成意图分类模板、快速路由决策表，提升弱模型执行质量（适合初始化/低峰时段调用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: { type: "string", description: "领域标签，如 industrial / oa / retail" },
          context: { type: "string", description: "领域背景描述，帮助强模型生成更准确的模板" },
        },
      },
      handler: async (_ctx, params) => {
        const domain = String(params.domain ?? "general");
        const context = String(params.context ?? "");
        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { status: "unavailable", reason: "ScaffoldEngine 未初始化" };
        }
        const result = await engine.generateDomainScaffold(domain, context);
        return { domain, generated: result, status: "deployed" };
      },
    },

    {
      id: "scaffold.generate_prompt",
      verb: "execute",
      description:
        "调用强模型生成少样本提示词模板，针对特定任务类型优化弱模型输出精度，完成后自动注册到 promptRegistry",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["task_type"],
        properties: {
          task_type: {
            type: "string",
            description: "任务类型，如 intent_classify / alarm_diagnose",
          },
          examples: { type: "array", items: { type: "string" }, description: "典型示例列表" },
          output_schema: { type: "object", description: "期望输出的 JSON Schema" },
        },
      },
      handler: async (_ctx, params) => {
        const taskType = String(params.task_type ?? "");
        const examples = Array.isArray(params.examples) ? (params.examples as string[]) : [];
        const outputSchema = params.output_schema;
        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { status: "unavailable", reason: "ScaffoldEngine 未初始化" };
        }
        const asset = await engine.generatePromptTemplate(taskType, examples, { outputSchema });
        await engine.deploy(asset);
        return { asset_id: asset.id, task_type: asset.task_type, status: "deployed" };
      },
    },

    {
      id: "scaffold.generate_decision_table",
      verb: "execute",
      description:
        "从示例中提炼确定性规则，生成零 LLM 调用的决策表，避免重复调用弱模型处理可规则化的判断",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["scenario"],
        properties: {
          scenario: { type: "string", description: "场景描述，如 '报警路由' / '工单优先级分配'" },
          examples: {
            type: "array",
            description: "示例列表，每条含 input 和 output",
            items: { type: "object" },
          },
        },
      },
      handler: async (_ctx, params) => {
        const scenario = String(params.scenario ?? "");
        const examples = Array.isArray(params.examples)
          ? (params.examples as Array<{ input: unknown; output: unknown }>)
          : [];
        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { status: "unavailable", reason: "ScaffoldEngine 未初始化" };
        }
        const asset = await engine.generateDecisionTable(scenario, examples);
        return { asset_id: asset.id, scenario, status: "generated" };
      },
    },

    {
      id: "scaffold.list",
      verb: "query",
      description:
        "查看所有已预生成的脚手架资产（Prompt 模板、决策表、Skill 脚本），含使用率和成功率统计",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "资产类型过滤：prompt_template / decision_table / skill_script",
          },
          domain: { type: "string", description: "领域过滤" },
        },
      },
      handler: async (_ctx, params) => {
        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { assets: [], count: 0, status: "unavailable" };
        }
        const typeFilter = params.type ? String(params.type) : undefined;
        const domainFilter = params.domain ? String(params.domain) : undefined;
        const assets = engine.list({ type: typeFilter, domain: domainFilter });
        return {
          assets: assets.map((a) => ({
            id: a.id,
            type: a.type,
            name: a.name,
            domain: a.domain,
            task_type: a.task_type,
            generated_by: a.generated_by,
            validated: a.validated,
            usage_count: a.usage_count,
            success_rate: a.success_rate,
          })),
          count: assets.length,
        };
      },
    },

    {
      id: "llm.scaffold",
      verb: "compose",
      description:
        "使用预定义的 scaffold 模板调用 LLM（弱模型补偿核心）：自动注入变量、few-shot 示例和输出约束，让弱模型只需填空而非自由推理。支持 {variable} 和 {{variable}} 两种占位符语法。",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["scaffold_id"],
        properties: {
          scaffold_id: { type: "string", description: "scaffold 的 ID" },
          variables: { type: "object", description: "注入模板的变量 key→value 映射" },
          extra_context: { type: "string", description: "追加到 prompt 头部的额外上下文" },
          max_tokens: { type: "number", description: "最大 token 数，默认 300" },
          require_json: {
            type: "boolean",
            description: "强制 JSON 输出（无需 output_schema 时设为 true）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const scaffoldId = String(params.scaffold_id ?? "");
        const variables = (params.variables ?? {}) as Record<string, unknown>;
        const extraContext = params.extra_context ? String(params.extra_context) : "";
        const requireJson = params.require_json === true;

        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { success: false, error: "ScaffoldEngine 未初始化", text: "" };
        }

        const asset = engine.get(scaffoldId);
        if (!asset) {
          // 降级：尝试 promptRegistry
          if (runtime.promptRegistry) {
            const rendered = runtime.promptRegistry.render(scaffoldId, variables);
            if (rendered) {
              const llmFn = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
              if (!llmFn)
                return { success: false, error: "LLM 未配置", text: "", scaffold_id: scaffoldId };
              try {
                const res = await llmFn({ prompt: rendered });
                return { text: res.text, success: true, scaffold_id: scaffoldId };
              } catch (err) {
                return {
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                  text: "",
                };
              }
            }
          }
          return {
            success: false,
            error: `scaffold not found: ${scaffoldId}`,
            text: "",
            scaffold_id: scaffoldId,
          };
        }

        // 解析 scaffold 内容（支持工业 JSON 格式与 ScaffoldAsset 两种结构）
        let scaffoldData: Record<string, unknown> = {};
        try {
          scaffoldData = JSON.parse(asset.content) as Record<string, unknown>;
        } catch {
          scaffoldData = {};
        }

        let promptTemplate = String(
          scaffoldData.prompt_template ?? scaffoldData.user_template ?? "",
        );
        const systemPrompt = String(scaffoldData.system ?? scaffoldData.system_prompt ?? "");
        const examples = Array.isArray(scaffoldData.examples) ? scaffoldData.examples : [];
        const outputSchema = scaffoldData.output_schema ?? scaffoldData.outputSchema;

        // 替换占位符（同时支持 {var} 和 {{var}} 两种语法）
        for (const [key, value] of Object.entries(variables)) {
          const strVal = String(value ?? "");
          promptTemplate = promptTemplate
            .replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), strVal)
            .replace(new RegExp(`\\{${key}\\}`, "g"), strVal);
        }
        if (extraContext) {
          promptTemplate = `${extraContext}\n\n${promptTemplate}`;
        }

        // 构建系统提示词 + few-shot 示例
        let fullSystem = systemPrompt;
        if (examples.length > 0) {
          fullSystem += "\n\n示例：\n";
          for (const ex of (examples as Array<{ input: unknown; output: unknown }>).slice(0, 3)) {
            fullSystem += `输入：${JSON.stringify(ex.input)}\n输出：${JSON.stringify(ex.output)}\n\n`;
          }
        }

        const fullPrompt = fullSystem ? `${fullSystem}\n\n${promptTemplate}` : promptTemplate;

        // 有 outputSchema 或要求 JSON → 使用结构化输出引擎
        if (requireJson || outputSchema) {
          if (runtime.structuredOutput && outputSchema) {
            try {
              const result = await runtime.structuredOutput.complete(
                fullPrompt,
                outputSchema as import("./structured-output.js").OutputSchema,
                { maxRetries: 2, fallback: {} },
              );
              engine.recordUsage(scaffoldId, !result.fallback);
              return {
                ...result.data,
                success: true,
                fallback: result.fallback,
                scaffold_id: scaffoldId,
              };
            } catch (err) {
              engine.recordUsage(scaffoldId, false);
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
                text: "",
              };
            }
          }
        }

        // 普通文本生成
        const llmFn = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
        if (!llmFn) {
          return { success: false, error: "LLM 未配置", text: "", scaffold_id: scaffoldId };
        }
        try {
          const res = await llmFn({ prompt: fullPrompt });
          engine.recordUsage(scaffoldId, true);
          return { text: res.text, success: true, scaffold_id: scaffoldId };
        } catch (err) {
          engine.recordUsage(scaffoldId, false);
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            text: "",
            scaffold_id: scaffoldId,
          };
        }
      },
    },
  ];
}

// ── L38: learn.* 交互学习能力 ──────────────────────────────────────────────
//
// 从每次成功交互中学习，写入 CBR（Case-Based Reasoning）和 KB，
// 弱模型下次遇到相似问题时直接命中已学案例，无需再次推理。

export function makeLearningCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "learn.from_interaction",
      verb: "execute",
      description:
        "将一次成功的用户交互（输入→意图→响应→反馈）存入 CBR 案例库和 KB，供弱模型后续直接命中",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["input", "response"],
        properties: {
          input: { type: "string", description: "用户原始输入" },
          intent: { type: "string", description: "识别到的意图" },
          response: { type: "string", description: "机器人的成功回复" },
          feedback_score: { type: "number", description: "用户反馈评分 0-1，默认 0.8" },
        },
      },
      handler: async (_ctx, params) => {
        const input = String(params.input ?? "");
        const intent = String(params.intent ?? "unknown");
        const response = String(params.response ?? "");
        const score = typeof params.feedback_score === "number" ? params.feedback_score : 0.8;

        const results: string[] = [];

        // 写入 CBR 案例库
        if (runtime.cbrStore) {
          try {
            runtime.cbrStore.add(input, response, {
              source: "interaction_learning",
              intent,
              score,
            });
            results.push("cbr");
          } catch {
            // CBR 写入失败时忽略
          }
        }

        // 写入 KB（供 RAG 检索）
        try {
          await runtime.kb.ingest(`用户问：${input}\n成功回复：${response}`, {
            source: "interaction_learning",
          });
          results.push("kb");
        } catch {
          // KB 写入失败时忽略
        }

        // 如果 ScaffoldEngine 存在，记录为脚手架成功使用
        if (runtime.scaffoldEngine && intent) {
          const scaffoldId = `scaffold-intent-${intent}`;
          runtime.scaffoldEngine.recordUsage(scaffoldId, score >= 0.7);
        }

        return { learned: true, stored_in: results, intent, score };
      },
    },

    {
      id: "learn.batch_from_history",
      verb: "execute",
      description:
        "扫描历史对话记录，批量写入 KB 和 CBR 案例库，让弱模型积累经验以减少重复 LLM 调用",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "处理的最大会话数量，默认 50" },
          min_score: { type: "number", description: "最低质量评分，低于此值跳过，默认 0.7" },
        },
      },
      handler: async (_ctx, params) => {
        const limit = typeof params.limit === "number" ? params.limit : 50;
        const minScore = typeof params.min_score === "number" ? params.min_score : 0.7;

        const contextEngine = runtime.contextEngine;
        if (!contextEngine) {
          return { learned: 0, status: "no_context_engine" };
        }

        const sessions: string[] = [];
        // 尝试从 context engine 获取会话列表
        if (
          typeof (contextEngine as unknown as Record<string, unknown>).listSessions === "function"
        ) {
          const listed = (
            (contextEngine as unknown as Record<string, unknown>).listSessions as () => string[]
          )();
          sessions.push(...listed.slice(0, limit));
        }

        let learned = 0;
        for (const sessionId of sessions) {
          try {
            const messages = contextEngine.getRecent(sessionId, 10);
            if (messages.length < 2) {
              continue;
            }
            const text = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
            await runtime.kb.add?.({
              id: `history-${sessionId}-${Date.now()}`,
              content: text,
              source: "history_learning",
            });
            learned++;
          } catch {
            // 单个会话失败时跳过
          }
        }

        return { learned, sessions_processed: sessions.length, min_score: minScore };
      },
    },

    {
      id: "learn.record_success",
      verb: "execute",
      description: "标记某次脚手架资产调用为成功/失败，用于更新成功率统计，指导后续资产优化",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["asset_id", "success"],
        properties: {
          asset_id: { type: "string", description: "脚手架资产 ID" },
          success: { type: "boolean", description: "是否成功" },
        },
      },
      handler: async (_ctx, params) => {
        const assetId = String(params.asset_id ?? "");
        const success = Boolean(params.success);
        runtime.scaffoldEngine?.recordUsage(assetId, success);
        return { recorded: true, asset_id: assetId, success };
      },
    },
  ];
}

// ── L39: evolve.* 进化与自适应能力 ──────────────────────────────────────────
//
// 在 EvolveEngine（自动 Playbook 生成）基础上，增加领域脚手架预热能力。
// evolve.prepare_domain 专门为弱模型场景设计：
//   强模型在低峰/初始化时预热 → 弱模型运行时直接使用预制资源。

// ── L40: research.* 多源研究能力 ────────────────────────────────────────────

export function makeResearchCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "research.query",
      verb: "acquire",
      description: "从 KB / 网络 / 事件日志并行搜索，LLM 综合分析，返回研究结论",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "研究问题" },
          sources: {
            type: "array",
            items: { type: "string", enum: ["kb", "web", "events"] },
            description: '数据来源，默认 ["kb","web"]',
          },
          depth: { type: "string", enum: ["quick", "thorough"], description: "搜索深度" },
          save_to_kb: { type: "boolean", description: "是否将结论写回知识库" },
        },
      },
      handler: async (_ctx, params) => {
        const agent = (runtime as Record<string, unknown>).researchAgent as
          | import("../agents/research-agent.js").ResearchAgent
          | undefined;
        if (!agent) {
          return { error: "ResearchAgent 未初始化" };
        }
        const { query, sources, depth, save_to_kb } = params as {
          query: string;
          sources?: Array<"kb" | "web" | "events">;
          depth?: "quick" | "thorough";
          save_to_kb?: boolean;
        };
        return await agent.research({ query, sources, depth, save_to_kb });
      },
    },
    {
      id: "research.monitor",
      verb: "execute",
      description: "持续监控话题，定期搜索并发布 research.monitor_update 事件",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["topic"],
        properties: {
          topic: { type: "string", description: "监控话题" },
          interval_hours: { type: "number", description: "监控间隔小时数，默认 6" },
        },
      },
      handler: async (_ctx, params) => {
        const agent = (runtime as Record<string, unknown>).researchAgent as
          | import("../agents/research-agent.js").ResearchAgent
          | undefined;
        if (!agent) {
          return { error: "ResearchAgent 未初始化" };
        }
        const { topic, interval_hours = 6 } = params as { topic: string; interval_hours?: number };
        const monitorId = await agent.monitor(topic, interval_hours);
        return { monitor_id: monitorId, topic, interval_hours };
      },
    },
    {
      id: "research.stop_monitor",
      verb: "execute",
      description: "停止话题监控",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["monitor_id"],
        properties: { monitor_id: { type: "string" } },
      },
      handler: async (_ctx, params) => {
        const agent = (runtime as Record<string, unknown>).researchAgent as
          | import("../agents/research-agent.js").ResearchAgent
          | undefined;
        agent?.stopMonitor(String(params.monitor_id ?? ""));
        return { stopped: true };
      },
    },
  ];
}

// ── L41: agent.* 智能体编排能力 ────────────────────────────────────────────

export function makeAgentOrchCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "agent.react",
      verb: "execute",
      description: "ReAct 模式：LLM 自主决策工具调用，迭代执行直到目标完成（安全白名单保护）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string", description: "智能体执行目标" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "允许使用的能力 ID 白名单",
          },
          max_iterations: { type: "integer", description: "最大迭代次数，默认 5" },
        },
      },
      handler: async (ctx, params) => {
        const { runReact } = await import("../agents/react-executor.js");
        const {
          goal,
          tools = [],
          max_iterations = 5,
        } = params as {
          goal: string;
          tools?: string[];
          max_iterations?: number;
        };
        return await runReact(goal, tools, max_iterations, runtime, {
          sessionId: ((ctx as Record<string, unknown>).sessionId as string) ?? "agent-react",
          userId: ((ctx as Record<string, unknown>).userId as string) ?? "system",
          source: "agent.react",
        });
      },
    },
    {
      id: "agent.plan",
      verb: "acquire",
      description: "将复杂目标分解为可并行执行的子任务列表",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: { type: "string", description: "需要分解的复杂目标" },
        },
      },
      handler: async (_ctx, params) => {
        const llm = runtime.llmComplete ?? runtime.bridges?.get(BRIDGE_LLM)?.complete;
        if (!llm) {
          return { goal: params.goal, subtasks: [], count: 0, error: "LLM 未配置" };
        }
        const caps = runtime.capabilities
          .list()
          .slice(0, 30)
          .map((c) => c.id);
        const prompt =
          `将目标分解为并行子任务：${params.goal}\n` +
          `可用能力：${caps.join(", ")}\n` +
          `返回JSON数组：[{"task":"子任务","capability":"能力ID","params":{}}]`;
        const res = await llm({ prompt });
        const m = res.text.match(/\[[\s\S]*\]/);
        const subtasks = m
          ? (() => {
              try {
                return JSON.parse(m[0]) as unknown[];
              } catch {
                return [];
              }
            })()
          : [];
        return { goal: params.goal, subtasks, count: subtasks.length };
      },
    },
    {
      id: "agent.spawn",
      verb: "execute",
      description:
        "后台异步执行子任务（能力调用或 ReAct 循环），通过 agent.task_completed 事件返回结果",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "任务 ID，不填则自动生成" },
          capability: { type: "string", description: "直接调用的能力 ID（二选一）" },
          capability_params: { type: "object", description: "能力参数" },
          react_goal: { type: "string", description: "ReAct 目标（二选一）" },
          tools: { type: "array", items: { type: "string" }, description: "ReAct 工具白名单" },
          max_iterations: { type: "integer", description: "ReAct 最大迭代次数" },
        },
      },
      handler: async (ctx, params) => {
        const {
          task_id = `task-${Date.now()}`,
          capability,
          capability_params,
          react_goal,
          tools = [],
          max_iterations = 3,
        } = params as {
          task_id?: string;
          capability?: string;
          capability_params?: Record<string, unknown>;
          react_goal?: string;
          tools?: string[];
          max_iterations?: number;
        };

        const spawnCtx = {
          sessionId: ((ctx as Record<string, unknown>).sessionId as string) ?? "agent-spawn",
          userId: ((ctx as Record<string, unknown>).userId as string) ?? "system",
          source: "agent.spawn",
          invoke: async (capId: string, p: Record<string, unknown>) =>
            runtime.capabilities.invoke(
              capId,
              { source: "agent.spawn", invoke: async () => ({}) },
              p,
            ),
        };

        void (async () => {
          try {
            let result: unknown;
            if (react_goal) {
              const { runReact } = await import("../agents/react-executor.js");
              result = await runReact(react_goal, tools, max_iterations, runtime, spawnCtx);
            } else if (capability) {
              result = await runtime.capabilities.invoke(
                capability,
                spawnCtx,
                capability_params ?? {},
              );
            }
            await runtime.kernel.publish("agent.task_completed", "agent-spawn", {
              task_id,
              result,
            });
          } catch (e) {
            await runtime.kernel
              .publish("agent.task_failed", "agent-spawn", {
                task_id,
                error: e instanceof Error ? e.message : String(e),
              })
              .catch(() => {});
          }
        })();

        return { task_id, status: "spawned" };
      },
    },
  ];
}

export function makeEvolveCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "evolve.prepare_domain",
      verb: "execute",
      description:
        "调用强模型为新领域预生成全套脚手架（Playbook/Prompt/Rule），之后弱模型可直接使用，无需推理",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: { type: "string", description: "目标领域，如 industrial / retail / healthcare" },
          description: { type: "string", description: "领域详细描述，帮助强模型理解业务场景" },
          examples: {
            type: "array",
            items: { type: "object" },
            description: "典型输入输出示例，用于生成决策表",
          },
        },
      },
      handler: async (_ctx, params) => {
        const domain = String(params.domain ?? "general");
        const description = String(params.description ?? "");
        const examples = Array.isArray(params.examples)
          ? (params.examples as Array<{ input: unknown; output: unknown }>)
          : [];

        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { status: "unavailable", reason: "ScaffoldEngine 未初始化" };
        }

        // 生成领域通用脚手架
        const scaffolds = await engine.generateDomainScaffold(domain, description);

        // 如果有示例，额外生成意图路由决策表
        let decisionTable = null;
        if (examples.length > 0) {
          const dt = await engine.generateDecisionTable(`${domain}.intent_routing`, examples);
          await engine.deploy(dt);
          decisionTable = {
            id: dt.id,
            rules_count: (() => {
              try {
                return (JSON.parse(dt.content) as Record<string, unknown[]>).rules?.length ?? 0;
              } catch {
                return 0;
              }
            })(),
          };
        }

        return {
          domain,
          scaffolds_generated: scaffolds,
          decision_table: decisionTable,
          status: "ready",
          note: "弱模型现可使用预制资源，无需自由推理",
        };
      },
    },

    {
      id: "evolve.scaffold_status",
      verb: "query",
      description: "查看所有领域的脚手架预热状态和弱模型补偿覆盖率",
      owner: { kind: "core" },
      handler: async () => {
        const engine = runtime.scaffoldEngine;
        if (!engine) {
          return { status: "unavailable", domains: [], total_assets: 0 };
        }
        const all = engine.list();
        const byDomain = new Map<string, number>();
        for (const a of all) {
          const d = a.domain ?? "general";
          byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
        }
        const domains = [...byDomain.entries()].map(([domain, count]) => ({
          domain,
          asset_count: count,
        }));
        return {
          status: "ok",
          domains,
          total_assets: all.length,
          validated: all.filter((a) => a.validated).length,
          avg_success_rate:
            all.length > 0
              ? (all.reduce((s, a) => s + a.success_rate, 0) / all.length).toFixed(3)
              : "N/A",
        };
      },
    },

    // ── object.upsert / object.batch_upsert — ObjectStore 写入 ──────────────
    {
      id: "object.upsert",
      verb: "modify",
      description: "创建或更新 ObjectStore 中的单个业务对象",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["type", "id"],
        properties: {
          type: { type: "string", description: "对象类型（如 EquipmentReading）" },
          id: { type: "string", description: "对象 ID（幂等键）" },
          fields: { type: "object", description: "字段值 map" },
        },
      },
      handler: async (_ctx, params) => {
        const type = String(params.type ?? "");
        const id = String(params.id ?? "");
        // 兼容 fields/data 两种参数命名
        const fields = ((params.fields ?? params.data) as Record<string, unknown>) ?? {};
        await runtime.objectStore.upsert(type, id, fields);
        await runtime.kernel.publish("object.upserted", "object.upsert", { type, id });
        return { status: "ok", type, id };
      },
    },
    {
      id: "object.batch_upsert",
      verb: "modify",
      description: "批量创建或更新 ObjectStore 中的业务对象",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", description: "对象类型" },
          records: {
            type: "array",
            description: "记录列表（records 或 items 均可）",
            items: {
              type: "object",
              properties: { id: { type: "string" }, fields: { type: "object" } },
            },
          },
          items: { type: "array", description: "records 的别名（兼容 rest-poll 连接器）" },
        },
      },
      handler: async (_ctx, params) => {
        const type = String(params.type ?? "");
        // 兼容 records/items 两种参数命名
        const records = (params.records ?? params.items ?? []) as Array<Record<string, unknown>>;
        let upserted = 0;
        for (const rec of records) {
          const id = String(rec.id ?? rec._id ?? "");
          if (id) {
            const fields = (rec.fields ?? rec.data ?? rec) as Record<string, unknown>;
            await runtime.objectStore.upsert(type, id, fields);
            upserted++;
          }
        }
        await runtime.kernel.publish("object.batch_upserted", "object.batch_upsert", {
          type,
          count: upserted,
        });
        return { status: "ok", type, upserted };
      },
    },

    // ── kb.add — 知识库写入（语义化别名） ────────────────────────────────────
    {
      id: "kb.add",
      verb: "acquire",
      description: "向知识库添加一段文本内容（kb.ingest 的简化别名）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string", description: "文本内容" },
          source: { type: "string", description: "来源标识（便于溯源）" },
          namespace: { type: "string", description: "命名空间（可选，用于隔离检索）" },
        },
      },
      handler: async (_ctx, params) => {
        const content = String(params.content ?? "");
        const source = String(params.source ?? "kb.add");
        const namespace = params.namespace ? String(params.namespace) : undefined;
        await runtime.kb.ingest(content, { source, namespace });
        return { status: "ok", length: content.length };
      },
    },

    // ── learn.record_interaction — 记录完整交互为学习数据 ───────────────────
    {
      id: "learn.record_interaction",
      verb: "acquire",
      description: "将用户输入 + 机器人响应记录为学习交互数据（供进化分析使用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["input", "response"],
        properties: {
          input: { type: "string", description: "用户输入文本" },
          response: { type: "string", description: "机器人响应文本" },
          intent: { type: "string", description: "识别出的意图（可选）" },
          outcome: {
            type: "string",
            enum: ["success", "failure", "unclear"],
            description: "交互结果（默认 success）",
          },
        },
      },
      handler: async (_ctx, params) => {
        const input = String(params.input ?? "");
        const response = String(params.response ?? "");
        const intent = params.intent ? String(params.intent) : undefined;
        const outcome = String(params.outcome ?? "success");
        // 写入 CBR 案例库供 few-shot 检索
        if (intent) {
          runtime.cbrStore?.add(input, intent, { outcome });
        }
        // 写入 KB 供长期知识积累
        const entry = `[interaction:${outcome}] Input: ${input}\nResponse: ${response}`;
        await runtime.kb.ingest(entry, { source: "learn.record_interaction" });
        // 发布进化观察事件
        await runtime.kernel.publish("learn.interaction_recorded", "learn.record_interaction", {
          input: input.slice(0, 200),
          intent,
          outcome,
        });
        return { status: "ok", outcome };
      },
    },

    // ── kb.search (别名) ──────────────────────────────────────────────────
    {
      id: "search_kb",
      verb: "retrieve",
      description: "在知识库中语义检索（kb.search 的别名，供 Pack YAML 使用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索查询文本" },
          namespace: { type: "string", description: "知识库命名空间（可选）" },
          top_k: { type: "number", description: "返回条数（默认 5）" },
        },
        required: ["query"],
      },
      handler: async (_ctx, params) => {
        const query = String(params.query ?? "");
        const namespace = params.namespace ? String(params.namespace) : undefined;
        const topK = Number(params.top_k ?? 5);
        const hits = await runtime.kb.search(query, {
          limit: topK,
          ...(namespace ? { namespace } : {}),
        });
        return { status: "ok", hits, count: hits.length };
      },
    },

    // ── kb.ingest_text (别名) ─────────────────────────────────────────────
    {
      id: "ingest_kb_text",
      verb: "acquire",
      description: "向知识库写入文本（kb.ingest 的别名，供 Pack YAML 使用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "要入库的文本内容" },
          content: { type: "string", description: "text 的别名" },
          source: { type: "string", description: "来源标识" },
          namespace: { type: "string", description: "知识库命名空间（可选）" },
        },
        required: [],
      },
      handler: async (_ctx, params) => {
        const text = String(params.text ?? params.content ?? "");
        const source = String(params.source ?? "ingest_kb_text");
        const namespace = params.namespace ? String(params.namespace) : undefined;
        await runtime.kb.ingest(text, { source, namespace });
        return { status: "ok", length: text.length };
      },
    },

    // ── object.update (别名) ──────────────────────────────────────────────
    {
      id: "update_object",
      verb: "modify",
      description: "更新 ObjectStore 中的业务对象字段（object.upsert 的别名，供 Pack YAML 使用）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "对象类型名" },
          id: { type: "string", description: "对象 ID" },
          fields: { type: "object", description: "要更新的字段（键值对）" },
          data: { type: "object", description: "fields 的别名" },
        },
        required: ["type", "id"],
      },
      handler: async (_ctx, params) => {
        const type = String(params.type ?? "");
        const id = String(params.id ?? "");
        const fields = ((params.fields ?? params.data) as Record<string, unknown>) ?? {};
        await runtime.objectStore.upsert(type, id, fields);
        await runtime.kernel.publish("object.updated", "update_object", { type, id });
        return { status: "ok", type, id };
      },
    },

    // ── kb.ingest_folder ─────────────────────────────────────────────────
    // 遍历本地目录，将符合类型的文件内容批量写入知识库
    {
      id: "ingest_folder",
      verb: "acquire",
      description: "将本地文件夹内的文档批量写入知识库",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          folder_path: { type: "string", description: "本地文件夹路径" },
          namespace: { type: "string", description: "知识库命名空间" },
          source_prefix: { type: "string", description: "来源标识前缀" },
          recursive: { type: "boolean", description: "是否递归子目录（默认 true）" },
          file_types: {
            type: "array",
            items: { type: "string" },
            description: "允许的文件后缀列表，默认 ['.txt','.md','.json','.csv','.yaml']",
          },
        },
        required: ["folder_path"],
      },
      handler: async (_ctx, params) => {
        const { readdir, readFile, stat } = await import("node:fs/promises");
        const path = await import("node:path");
        const folderPath = String(params.folder_path ?? "");
        const namespace = params.namespace ? String(params.namespace) : undefined;
        const sourcePrefix = String(params.source_prefix ?? folderPath);
        const recursive = params.recursive !== false;
        const allowedTypes = Array.isArray(params.file_types)
          ? (params.file_types as string[])
          : [".txt", ".md", ".json", ".csv", ".yaml", ".yml"];

        let ingested = 0;
        let errors = 0;
        let total = 0;

        const walk = async (dir: string): Promise<void> => {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(dir, entry);
            let s: { isDirectory(): boolean };
            try {
              s = await stat(full);
            } catch {
              continue;
            }
            if (s.isDirectory() && recursive) {
              await walk(full);
            } else if (allowedTypes.some((ext) => entry.endsWith(ext))) {
              total++;
              try {
                const content = await readFile(full, "utf-8");
                const source = `${sourcePrefix}/${path.relative(folderPath, full)}`;
                await runtime.kb.ingest(content, { source, namespace });
                ingested++;
              } catch {
                errors++;
              }
            }
          }
        };

        await walk(folderPath);
        return { status: "ok", total, ingested, errors };
      },
    },

    // ── 商业对象创建（enterprise-commercial pack 专用）──────────────────────
    {
      id: "create_bid_project",
      verb: "modify",
      description: "在 ObjectStore 中创建投标项目（BidProject），返回项目 ID",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "项目名称" },
          customer_name: { type: "string", description: "招标方名称" },
          customer_id: { type: "string", description: "招标方 ID" },
          bid_deadline: { type: "string", description: "投标截止日期（ISO 8601）" },
          budget_amount: { type: "number", description: "预算金额（元）" },
          project_type: { type: "string", description: "项目类型" },
          requirements: { type: "string", description: "招标需求描述" },
          our_advantage: { type: "string", description: "我方优势说明" },
          kb_namespace: { type: "string", description: "关联知识库命名空间" },
        },
        required: ["title"],
      },
      handler: async (_ctx, params) => {
        const id = `bid-prj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const fields: Record<string, unknown> = {
          title: String(params.title ?? ""),
          customer_name: String(params.customer_name ?? ""),
          customer_id: String(params.customer_id ?? ""),
          bid_deadline: String(params.bid_deadline ?? ""),
          budget_amount: Number(params.budget_amount ?? 0),
          project_type: String(params.project_type ?? ""),
          requirements: String(params.requirements ?? ""),
          our_advantage: String(params.our_advantage ?? ""),
          kb_namespace: String(params.kb_namespace ?? "company"),
          status: "drafting",
          created_at: new Date().toISOString(),
        };
        await runtime.objectStore.upsert("BidProject", id, fields);
        await runtime.kernel.publish("object.upserted", "create_bid_project", {
          type: "BidProject",
          id,
        });
        return { status: "ok", id, ...fields };
      },
    },

    {
      id: "create_bid_document",
      verb: "modify",
      description: "在 ObjectStore 中创建投标文件（BidDocument），返回文件 ID",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          bid_project_id: { type: "string", description: "所属投标项目 ID" },
          doc_type: {
            type: "string",
            description: "文件类型（full_bid_package/technical_proposal 等）",
          },
          title: { type: "string", description: "文件标题" },
          content: { type: "string", description: "文件正文（Markdown）" },
          generated_at: { type: "string", description: "生成时间（ISO 8601）" },
        },
        required: ["bid_project_id", "content"],
      },
      handler: async (_ctx, params) => {
        const id = `bid-doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const fields: Record<string, unknown> = {
          bid_project_id: String(params.bid_project_id ?? ""),
          doc_type: String(params.doc_type ?? "full_bid_package"),
          title: String(params.title ?? "投标文件"),
          content: String(params.content ?? ""),
          generated_at: String(params.generated_at ?? new Date().toISOString()),
          status: "generated",
          created_at: new Date().toISOString(),
        };
        await runtime.objectStore.upsert("BidDocument", id, fields);
        await runtime.kernel.publish("object.upserted", "create_bid_document", {
          type: "BidDocument",
          id,
        });
        return { status: "ok", id, ...fields };
      },
    },

    {
      id: "create_quote",
      verb: "modify",
      description: "在 ObjectStore 中创建报价单（Quote），返回报价单 ID 和编号",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          customer_name: { type: "string", description: "客户名称" },
          customer_id: { type: "string", description: "客户 ID" },
          project_name: { type: "string", description: "项目名称" },
          items: { type: "array", description: "报价明细列表" },
          valid_days: { type: "number", description: "有效天数（默认 30）" },
          payment_terms: { type: "string", description: "付款条款" },
          notes: { type: "string", description: "备注" },
          created_by: { type: "string", description: "创建人（user_id）" },
        },
        required: ["customer_name"],
      },
      handler: async (_ctx, params) => {
        const id = `quote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const quoteNo = `Q-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const fields: Record<string, unknown> = {
          customer_name: String(params.customer_name ?? ""),
          customer_id: String(params.customer_id ?? ""),
          project_name: String(params.project_name ?? "未命名项目"),
          items: Array.isArray(params.items) ? params.items : [],
          valid_days: Number(params.valid_days ?? 30),
          payment_terms: String(params.payment_terms ?? "合同签署后30日内付款"),
          notes: String(params.notes ?? ""),
          created_by: String(params.created_by ?? "system"),
          quote_no: quoteNo,
          status: "draft",
          created_at: new Date().toISOString(),
        };
        await runtime.objectStore.upsert("Quote", id, fields);
        await runtime.kernel.publish("object.upserted", "create_quote", {
          type: "Quote",
          id,
          quote_no: quoteNo,
        });
        return { status: "ok", id, quote_no: quoteNo, ...fields };
      },
    },

    {
      id: "evolve.generate_simulations",
      verb: "execute",
      description: "用强模型生成模拟业务场景（用于弱模型对比测试和进化验证）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "业务领域：industrial/enterprise/general（默认 industrial）",
          },
          count: { type: "number", description: "生成场景数量（默认 10）" },
        },
      },
      handler: async (_ctx, params) => {
        const llmBridge = runtime.bridges?.get(BRIDGE_LLM);
        const llmFn = llmBridge?.complete ?? runtime.llmComplete;
        if (!llmFn) {
          return { status: "error", reason: "需要 llmComplete 才能生成模拟场景" };
        }

        const domain = String(params.domain ?? "industrial");
        const count = Math.max(1, Math.min(50, Number(params.count ?? 10)));

        const domainLabel =
          domain === "industrial"
            ? "工业生产（巡检、告警、工单、设备维护）"
            : domain === "enterprise"
              ? "通用企业办公（审批、汇报、查询、协作）"
              : "通用场景";

        const prompt = `你是一个工业机器人系统的测试专家。
请生成 ${count} 个真实的用户输入场景，用于测试意图分类准确性。

领域：${domainLabel}

输出严格 JSON 格式：
{
  "scenarios": [
    {
      "user_input": "用户说的话",
      "expected_intent": "期望识别的意图名（knowledge_query/alarm_report/workorder_create/workorder_query/equipment_status/system_status/help/chat）",
      "difficulty": "easy|medium|hard",
      "notes": "为何这个场景有挑战性（可选）"
    }
  ]
}

要求：
- 包含简单直白的输入（easy）和模糊/口语化输入（hard）
- hard 场景模拟弱模型容易混淆的情况
- 全部用中文`;

        try {
          const response = await llmFn({ prompt, temperature: 0.7 });
          const text =
            typeof response === "string"
              ? response
              : (((response as Record<string, unknown>).text as string | undefined) ?? "");

          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            return { status: "error", reason: "LLM 未返回有效 JSON" };
          }

          const parsed = JSON.parse(jsonMatch[0]) as { scenarios: unknown[] };
          const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];

          await runtime.kb.ingest(JSON.stringify(scenarios, null, 2), {
            source: `simulation_scenarios_${domain}`,
            namespace: "test_scenarios",
          });

          return {
            status: "ok",
            domain,
            count: scenarios.length,
            scenarios,
            stored_in_kb: true,
          };
        } catch (e) {
          return { status: "error", reason: String(e) };
        }
      },
    },
  ];
}

// ── L43: vision.* 视觉识别连接器 ─────────────────────────────────────────
//
// 架构分层：
// - Connector 层：OCR/目标检测/帧预处理 → 结构化 JSON
// - Robot 层：LLM 对结构化结果推理决策
// - 弱模型路径：只消费结构化文本，不直接处理原始图像

export function makeVisionCapabilities(runtime: ClaworksRuntime): CapabilityDescriptor[] {
  return [
    {
      id: "vision.analyze",
      verb: "retrieve",
      description:
        "分析图片内容，返回对象识别、文字提取和场景描述（连接器层预处理，结构化输出供弱模型推理）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "图片 URL" },
          prompt: { type: "string", description: "额外分析指令（可选）" },
        },
        required: ["image_url"],
      },
      handler: async (_ctx, params) => {
        const imageUrl = String(params.image_url ?? "");
        const extraPrompt = params.prompt ? String(params.prompt) : "";
        const llm = runtime.llmComplete ?? runtime.bridges?.get(BRIDGE_LLM)?.complete;

        if (!llm) {
          return {
            status: "no_llm",
            image_url: imageUrl,
            scene_description: "视觉分析需要配置 LLM bridge",
            objects: [],
            text_regions: [],
          };
        }

        const analysisPrompt = `分析这张图片${extraPrompt ? "（" + extraPrompt + "）" : ""}。
返回严格 JSON：
{"objects": [{"label": "物体名称", "confidence": 0.9}], "text_regions": [{"text": "识别到的文字"}], "scene_description": "整体场景描述"}
图片 URL：${imageUrl}`;

        try {
          const response = await llm({ prompt: analysisPrompt });
          const text =
            typeof response === "string"
              ? response
              : String((response as Record<string, unknown>).text ?? "{}");
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          const parsed = jsonMatch ? (JSON.parse(jsonMatch[0]) as Record<string, unknown>) : {};
          return {
            status: "ok",
            image_url: imageUrl,
            objects: (parsed.objects ?? []) as unknown[],
            text_regions: (parsed.text_regions ?? []) as unknown[],
            scene_description: String(parsed.scene_description ?? ""),
            analyzed_at: new Date().toISOString(),
          };
        } catch (e) {
          return {
            status: "error",
            reason: String(e),
            image_url: imageUrl,
            objects: [],
            text_regions: [],
          };
        }
      },
    },
  ];
}
