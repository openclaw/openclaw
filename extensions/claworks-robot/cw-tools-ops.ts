import {
  buildAlarmSummary,
  buildHealthPayload,
  listObservationEvents,
  runClaworksDoctor,
  runClaworksDoctorFix,
  type ClaworksRuntime,
  type PlaybookRun,
} from "@claworks/runtime";
import { jsonResult, ToolInputError } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { ClaworksBridge } from "./bridge.js";
import { registerCwTool } from "./cw-tools-shared.js";

function resolveWaitingHitlStepId(run: PlaybookRun): string {
  const waiting = run.steps.find((s) => s.status === "waiting");
  if (waiting) {
    return waiting.stepId;
  }
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    const out = step?.output;
    if (out && typeof out === "object" && out !== null && "hitl_token" in out) {
      return step.stepId;
    }
  }
  throw new ToolInputError(`No waiting HITL step found on run ${run.id}`);
}

export function registerClaworksOpsTools(
  api: OpenClawPluginApi,
  getRuntime: () => ClaworksRuntime | null,
  getBridge?: () => ClaworksBridge | null,
): void {
  registerCwTool(api, getRuntime, {
    name: "cw_status",
    label: "ClaWorks health status",
    description: "In-process GET /v1/health equivalent (robot health + doctor checks).",
    parameters: Type.Object({}),
    execute(rt) {
      return buildHealthPayload(rt);
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_doctor_run",
    label: "ClaWorks doctor",
    description: "Run platform doctor checks (POST /v1/doctor equivalent).",
    parameters: Type.Object({
      fix: Type.Optional(Type.Boolean()),
      severity: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
    }),
    async execute(rt, params) {
      let fix_applied = false;
      let fix_actions: string[] = [];
      let fix_warnings: string[] = [];
      if (params.fix === true) {
        const fix = await runClaworksDoctorFix(rt);
        fix_applied = fix.applied.length > 0;
        fix_actions = fix.applied;
        fix_warnings = fix.warnings;
      }
      const checks = runClaworksDoctor(rt);
      return {
        checks,
        fix_requested: params.fix === true,
        fix_applied,
        fix_actions,
        fix_warnings,
        filtered_severity: params.severity ? String(params.severity) : null,
        filtered_category: params.category ? String(params.category) : null,
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_instances",
    label: "List ClaWorks instances",
    description:
      "Host robot exposes a single embedded instance (remote bridge lists multiple configured instances).",
    parameters: Type.Object({}),
    execute(rt) {
      return {
        default: "local",
        instances: [
          {
            id: "local",
            role: rt.robot.role,
            url: rt.robot.endpoint,
            label: rt.robot.name,
          },
        ],
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_list_types",
    label: "List object types",
    description: "List registered Ontology ObjectType names.",
    parameters: Type.Object({}),
    execute(rt) {
      return {
        types: rt.ontology.listTypes().map((t) => ({
          name: t.name,
          pack: t.pack,
        })),
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_get_object",
    label: "Get object",
    description: "Fetch one ObjectStore document by type and id.",
    parameters: Type.Object({
      type_name: Type.String(),
      object_id: Type.String(),
    }),
    async execute(rt, params) {
      const obj = await rt.objectStore.get(String(params.type_name), String(params.object_id));
      if (!obj) {
        throw new ToolInputError(`Object not found: ${params.type_name}/${params.object_id}`);
      }
      return { object: obj };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_create_object",
    label: "Create object",
    description: "Create a new ObjectStore document.",
    parameters: Type.Object({
      type_name: Type.String(),
      data: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(rt, params) {
      const obj = await rt.objectStore.create(
        String(params.type_name),
        (params.data ?? {}) as Record<string, unknown>,
      );
      return { object: obj };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_import_objects",
    label: "Import objects",
    description: "Bulk create ObjectStore records from a JSON array.",
    parameters: Type.Object({
      type_name: Type.String(),
      records: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(rt, params) {
      const typeName = String(params.type_name);
      const records = (params.records ?? []) as Array<Record<string, unknown>>;
      const created = [];
      for (const record of records) {
        created.push(await rt.objectStore.create(typeName, record));
      }
      return { imported: created.length, type_name: typeName };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_playbook_runs",
    label: "List playbook runs",
    description: "List playbook execution history with optional filters.",
    parameters: Type.Object({
      playbook_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(rt, params) {
      const runs = await rt.playbookEngine.listRuns({
        playbookId: params.playbook_id ? String(params.playbook_id) : undefined,
        status: params.status ? String(params.status) : undefined,
        limit: typeof params.limit === "number" ? params.limit : 50,
      });
      return { runs };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_reload_playbooks",
    label: "Reload playbooks",
    description: "Reload packs from disk (refreshes playbook YAML; same as cw_reload_packs).",
    parameters: Type.Object({}),
    async execute(rt) {
      const { reloadClaworksPacksFromDisk } = await import("@claworks/runtime");
      const { packs } = await reloadClaworksPacksFromDisk(rt);
      return {
        status: "ok",
        playbooks: rt.playbookEngine.list().map((p) => p.id),
        pack_ids: packs.map((p) => p.manifest.id),
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_hitl_pending",
    label: "Pending HITL",
    description: "List playbook runs waiting for human approval.",
    parameters: Type.Object({}),
    async execute(rt) {
      const runs = await rt.playbookEngine.listRuns({ status: "waiting_hitl", limit: 50 });
      return {
        pending: runs.map((run) => ({
          run_id: run.id,
          playbook_id: run.playbookId,
          started_at: run.startedAt,
          waiting_step_id: run.steps.find((s) => s.status === "waiting")?.stepId ?? null,
          steps: run.steps,
        })),
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_hitl_approve",
    label: "Approve HITL",
    description: "Approve a waiting playbook run and resume execution.",
    parameters: Type.Object({
      run_id: Type.String(),
      comment: Type.Optional(Type.String()),
      step_id: Type.Optional(Type.String()),
    }),
    async execute(rt, params) {
      const runId = String(params.run_id);
      const run = await rt.playbookEngine.getRun(runId);
      if (!run || run.status !== "waiting_hitl") {
        throw new ToolInputError(`Run ${runId} is not waiting for HITL`);
      }
      const stepId = params.step_id ? String(params.step_id) : resolveWaitingHitlStepId(run);
      const updated = await rt.playbookEngine.submitHitlDecision(
        runId,
        stepId,
        "approve",
        params.comment ? String(params.comment) : undefined,
      );
      return { run_id: updated.id, status: updated.status, step_id: stepId };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_hitl_reject",
    label: "Reject HITL",
    description: "Reject a waiting playbook run.",
    parameters: Type.Object({
      run_id: Type.String(),
      reason: Type.Optional(Type.String()),
      step_id: Type.Optional(Type.String()),
    }),
    async execute(rt, params) {
      const runId = String(params.run_id);
      const run = await rt.playbookEngine.getRun(runId);
      if (!run || run.status !== "waiting_hitl") {
        throw new ToolInputError(`Run ${runId} is not waiting for HITL`);
      }
      const stepId = params.step_id ? String(params.step_id) : resolveWaitingHitlStepId(run);
      const updated = await rt.playbookEngine.submitHitlDecision(
        runId,
        stepId,
        "reject",
        params.reason ? String(params.reason) : undefined,
      );
      return { run_id: updated.id, status: updated.status, step_id: stepId };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_alarm_summary",
    label: "Alarm summary",
    description: "Active alarm counts by severity from ObjectStore Alarm type.",
    parameters: Type.Object({
      station_id: Type.Optional(Type.String()),
    }),
    async execute(rt, params) {
      return buildAlarmSummary(rt, params.station_id ? String(params.station_id) : undefined);
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_playbooks_list",
    label: "List playbooks (compact)",
    description: "以精简格式列出所有已加载的 Playbook（id、名称、Pack、触发器类型）。",
    parameters: Type.Object({
      pack: Type.Optional(Type.String({ description: "按 Pack ID 过滤" })),
    }),
    execute(rt, params) {
      const list = rt.playbookEngine.list();
      const filtered = params.pack ? list.filter((p) => p.pack === String(params.pack)) : list;
      return {
        total: filtered.length,
        playbooks: filtered.map((p) => ({
          id: p.id,
          name: p.name,
          pack: p.pack,
          trigger_kind: Array.isArray(p.trigger) ? p.trigger[0]?.kind : p.trigger?.kind,
        })),
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_update_object",
    label: "Update object",
    description: "部分更新 ObjectStore 中的单个对象（PATCH 语义，只修改指定字段）。",
    parameters: Type.Object({
      type_name: Type.String({ description: "对象类型名" }),
      id: Type.String({ description: "对象 ID" }),
      patch: Type.Record(Type.String(), Type.Unknown(), { description: "需要更新的字段" }),
    }),
    async execute(rt, params) {
      const typeName = String(params.type_name);
      const id = String(params.id);
      const patch = (params.patch ?? {}) as Record<string, unknown>;
      const updated = await rt.objectStore.update(typeName, id, patch);
      return { ok: true, type_name: typeName, id, updated };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_delete_object",
    label: "Delete object",
    description: "从 ObjectStore 中删除单个对象（永久删除，不可恢复）。",
    parameters: Type.Object({
      type_name: Type.String({ description: "对象类型名" }),
      id: Type.String({ description: "对象 ID" }),
    }),
    async execute(rt, params) {
      const typeName = String(params.type_name);
      const id = String(params.id);
      await rt.objectStore.delete(typeName, id);
      return { ok: true, type_name: typeName, id };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_list_events",
    label: "List recent events",
    description: "列出 EventKernel 近期接收到的事件（可按 type、source 过滤）。",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "事件类型过滤（支持 glob，如 alarm.*）" })),
      source: Type.Optional(Type.String({ description: "来源过滤" })),
      limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 20", default: 20 })),
    }),
    execute(_rt, params) {
      const limit = params.limit ? Number(params.limit) : 20;
      const typeFilter = params.type ? String(params.type) : undefined;
      const sourceFilter = params.source ? String(params.source) : undefined;
      let events = listObservationEvents(Math.min(limit * 3, 200));
      if (typeFilter) {
        const pattern = typeFilter.replace(/\./g, "\\.").replace(/\*/g, ".*");
        const re = new RegExp(`^${pattern}$`);
        events = events.filter((e) => re.test(e.type));
      }
      if (sourceFilter) {
        events = events.filter((e) => e.source === sourceFilter);
      }
      events = events.slice(0, limit);
      return { total: events.length, events };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_list_packs",
    label: "List installed packs",
    description:
      "列出当前已加载的所有 Pack（id、名称、版本、提供的 ObjectType 和 Playbook 数量）。",
    parameters: Type.Object({}),
    execute(rt) {
      return {
        total: rt.loadedPacks.length,
        packs: rt.loadedPacks.map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          objectTypes: p.manifest.provides.objectTypes.length,
          playbooks: p.manifest.provides.playbooks.length,
          actionTypes: p.manifest.provides.actionTypes.length,
        })),
      };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_list_connectors",
    label: "List connectors",
    description: "列出所有外部 Connector 及其运行状态（pid、就绪状态、最近错误）。",
    parameters: Type.Object({}),
    execute(rt) {
      return { connectors: rt.connectorManager.status() };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_invoke_connector",
    label: "Invoke connector method",
    description: "调用外部 Connector 的指定方法（等价于 POST /v1/connectors/{id}/invoke）。",
    parameters: Type.Object({
      connector_id: Type.String({ description: "Connector ID" }),
      method: Type.String({ description: "方法名" }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "方法参数" }),
      ),
    }),
    async execute(rt, rawParams) {
      const connectorId = String(rawParams.connector_id);
      const method = String(rawParams.method);
      const params = (rawParams.params ?? {}) as Record<string, unknown>;
      const result = await rt.connectorManager.invoke(connectorId, method, params);
      return { ok: true, result };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_send_message",
    label: "Send message to user",
    description:
      "通过已配置的 IM 渠道主动向用户发送消息（机器人推送通知）。" +
      "需先在 claworks-robot 配置中设置 notify.targets。",
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息文本" }),
      user_id: Type.Optional(
        Type.String({ description: "目标用户 ID（省略时发送给 default target）" }),
      ),
      channel: Type.Optional(
        Type.String({ description: "目标渠道 ID（如 feishu / weixin-work）" }),
      ),
      channels: Type.Optional(
        Type.Array(Type.String(), { description: "多渠道发送（与 channel 二选一）" }),
      ),
    }),
    async execute(rt, params) {
      const message = String(params.message ?? "");
      const channels = Array.isArray(params.channels)
        ? (params.channels as string[])
        : params.channel
          ? [String(params.channel)]
          : undefined;

      const bridge = getBridge?.();
      if (bridge?.notify) {
        await bridge.notify({ message, channels });
        return { ok: true, message, channels: channels ?? ["default"] };
      }

      // Fallback: use comms.send capability if bridge not available
      const ctx = {
        source: "cw_send_message",
        subjectId: params.user_id ? String(params.user_id) : "system",
        runId: `tool-${Date.now()}`,
      };
      const result = await rt.kernel.callCapability("comms.send", ctx, {
        message,
        channels,
        userId: params.user_id ? String(params.user_id) : undefined,
      });
      return { ok: true, ...result };
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_evolution_export",
    label: "Export evolution data",
    description:
      "导出机器人进化数据包（脱敏）：失败 Playbook 统计、低置信度意图、HITL 决策记录。" +
      "将输出保存为 JSON 文件，传输到有互联网的机器上运行 generate-evolution-pack.ts。",
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({ description: "收集最近多少天的数据（默认 30 天）", default: 30 }),
      ),
    }),
    async execute(rt, params) {
      const mgr = rt.evolutionSync;
      if (!mgr) {
        return { status: "unavailable", reason: "evolutionSync 管理器未初始化" };
      }
      return mgr.exportEvolutionData(
        typeof params.days === "number" ? params.days : 30,
      ) as unknown as Record<string, unknown>;
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_evolution_import",
    label: "Import evolution pack",
    description:
      "导入进化包（由外部商业模型处理生成后返还）。" +
      "热更新 Playbook、规则决策表、提示词模板、知识库条目，无需重启。",
    parameters: Type.Object({
      pack: Type.Record(Type.String(), Type.Unknown(), {
        description: "EvolutionPack JSON（由 generate-evolution-pack.ts 生成）",
      }),
    }),
    async execute(rt, params) {
      const mgr = rt.evolutionSync;
      if (!mgr) {
        return { status: "unavailable", reason: "evolutionSync 管理器未初始化" };
      }
      const pack = params.pack as import("@claworks/runtime").EvolutionPack;
      if (!pack?.version) {
        return { status: "error", reason: "pack 参数无效" };
      }
      return mgr.importEvolutionPack(pack) as unknown as Record<string, unknown>;
    },
  });

  registerCwTool(api, getRuntime, {
    name: "cw_evolution_status",
    label: "Evolution sync status",
    description: "查看进化同步历史：最近导入了哪些进化包，应用了多少改进。",
    parameters: Type.Object({}),
    execute(rt) {
      const mgr = rt.evolutionSync;
      if (!mgr) {
        return { status: "unavailable", history: [], total_imported: 0 };
      }
      return { ...mgr.getStatus(), history: mgr.getHistory().slice(0, 10) };
    },
  });

  api.registerTool(
    {
      name: "cw_update_config",
      label: "Update ClaWorks config",
      description:
        "更新 claworks.json 中 claworks-robot 插件的配置段（如 notify.targets、packs、data.kb_provider 等）。" +
        "写入后 Gateway 热重载配置，ClaWorks runtime 在下次重启后生效。",
      parameters: Type.Object({
        path: Type.Array(Type.String(), {
          description:
            '配置路径（从 plugins.entries.claworks-robot.config 开始的子路径），例如 ["notify", "default_channel"]',
        }),
        value: Type.Unknown({ description: "写入的值（任意 JSON）" }),
      }),
      async execute(_id, params) {
        const pathSegments = (params.path as string[]).map(String);
        const value = params.value;
        await api.runtime.config.mutateConfigFile({
          afterWrite: "hot-reload",
          mutate(draft) {
            // Navigate to plugins.entries.claworks-robot.config.<path>
            const plugin = ((draft.plugins?.entries as Record<string, unknown> | undefined) ?? {})[
              "claworks-robot"
            ] as Record<string, unknown> | undefined;
            if (!plugin) {
              throw new ToolInputError(
                "claworks-robot plugin entry missing in ~/.claworks/claworks.json — run claworks doctor --fix or pnpm claworks:init",
              );
            }
            let cursor = (plugin.config ?? {}) as Record<string, unknown>;
            plugin.config = cursor;
            for (let i = 0; i < pathSegments.length - 1; i++) {
              const seg = pathSegments[i]!;
              if (typeof cursor[seg] !== "object" || cursor[seg] === null) {
                cursor[seg] = {};
              }
              cursor = cursor[seg] as Record<string, unknown>;
            }
            const last = pathSegments[pathSegments.length - 1];
            if (!last) {
              throw new ToolInputError("path must have at least one segment");
            }
            cursor[last] = value;
          },
        });
        return jsonResult({ ok: true, path: pathSegments, value });
      },
    },
    { name: "cw_update_config" },
  );
}
