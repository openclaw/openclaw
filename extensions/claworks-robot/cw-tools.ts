import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaworksRuntime } from "@claworks/runtime";
import { installClaworksPack, reloadClaworksPacksFromDisk } from "@claworks/runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function requireRuntime(getRuntime: () => ClaworksRuntime | null): ClaworksRuntime {
  const rt = getRuntime();
  if (!rt) {
    throw new Error("ClaWorks runtime is not started");
  }
  return rt;
}

function customPackRoot(): string {
  return join(homedir(), ".claworks", "packs", "custom");
}

function ensureCustomPackLayout(): void {
  const root = customPackRoot();
  mkdirSync(join(root, "ontology", "playbooks"), { recursive: true });
  const manifestPath = join(root, "claworks.pack.json");
  try {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          id: "custom",
          name: "Custom operator pack",
          version: "1.0.0",
          license: "MIT",
          provides: { objectTypes: [], playbooks: [], actionTypes: [] },
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  } catch {
    // manifest already exists
  }
}

export function registerClaworksAgentTools(
  api: OpenClawPluginApi,
  getRuntime: () => ClaworksRuntime | null,
): void {
  api.registerTool(
    {
      name: "cw_get_identity",
      label: "Get robot identity",
      description:
        "返回机器人的身份宣言（名称、角色、规则列表、业务域）以及当前状态概要。用于了解机器人的能力边界和核心规则。",
      parameters: Type.Object({
        include_agent_md: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const identity = rt.identity;
        const playbookCount = rt.playbookEngine.list().length;
        const connectors = rt.connectorManager.list();
        const result: Record<string, unknown> = {
          name: identity.name,
          role: identity.role,
          domain: identity.domain,
          description: identity.description,
          rules: identity.rules,
          robot_endpoint: rt.robot.endpoint,
          robot_version: rt.robot.version,
          loaded_packs: rt.loadedPacks.map((p) => ({
            id: p.manifest.id,
            version: p.manifest.version,
          })),
          playbook_count: playbookCount,
          connector_count: connectors.length,
          connectors: connectors.map((c) => ({ id: c.id, status: c.status })),
        };
        if (params.include_agent_md) {
          result.agent_md = identity.agentMd;
        }
        return textResult(result);
      },
    },
    { name: "cw_get_identity" },
  );

  api.registerTool(
    {
      name: "cw_bridge_im_message",
      label: "Bridge IM message to ClaWorks",
      description:
        "将 IM 频道用户消息路由到 ClaWorks EventKernel（经过 IngressRouter 决策）。" +
        "当 Pi Agent 接收到用户的 IM 消息时，可调用此工具将消息转发给业务事件系统。" +
        "Ingress 策略会决定是否触发 Playbook、仅记录还是直接忽略。",
      parameters: Type.Object({
        channel: Type.String({ description: "IM 频道标识，例如 feishu / weixin-work / dingtalk" }),
        message_id: Type.String({ description: "平台原始消息 ID（用于幂等性去重）" }),
        user_id: Type.String({ description: "发送消息的用户 ID（平台内标识）" }),
        text: Type.String({ description: "消息纯文本内容" }),
        group_id: Type.Optional(Type.String({ description: "群组/会话 ID（可选）" })),
        extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { bridgeImMessage } = await import("@claworks/runtime");
        const result = await bridgeImMessage(rt, {
          channel: String(params.channel),
          messageId: String(params.message_id),
          userId: String(params.user_id),
          text: String(params.text),
          groupId: params.group_id ? String(params.group_id) : undefined,
          extra: params.extra as Record<string, unknown> | undefined,
        });
        return textResult(result);
      },
    },
    { name: "cw_bridge_im_message" },
  );

  api.registerTool(
    {
      name: "cw_publish_event",
      label: "Publish ClaWorks event",
      description: "Publish an event to the ClaWorks EventKernel",
      parameters: Type.Object({
        type: Type.String(),
        source: Type.Optional(Type.String()),
        payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const matches = await rt.kernel.publish(
          String(params.type),
          String(params.source ?? "agent"),
          (params.payload ?? {}) as Record<string, unknown>,
        );
        return textResult({ matched_playbooks: matches.map((m) => m.playbookId) });
      },
    },
    { name: "cw_publish_event" },
  );

  api.registerTool(
    {
      name: "cw_trigger_playbook",
      label: "Trigger ClaWorks playbook",
      description: "Manually trigger a playbook by id",
      parameters: Type.Object({
        playbook_id: Type.String(),
        input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const run = await rt.playbookEngine.trigger(
          String(params.playbook_id),
          (params.input ?? {}) as Record<string, unknown>,
        );
        return textResult({ run_id: run.id, status: run.status });
      },
    },
    { name: "cw_trigger_playbook" },
  );

  api.registerTool(
    {
      name: "cw_reload_packs",
      label: "Reload ClaWorks packs",
      description: "Hot-reload installed packs from disk",
      parameters: Type.Object({}),
      async execute() {
        const rt = requireRuntime(getRuntime);
        const { packs } = await reloadClaworksPacksFromDisk(rt);
        return textResult({
          status: "ok",
          total: packs.length,
          pack_ids: packs.map((p) => p.manifest.id),
        });
      },
    },
    { name: "cw_reload_packs" },
  );

  api.registerTool(
    {
      name: "cw_kb_search",
      label: "Search ClaWorks KB",
      description: "Search the robot knowledge base",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const results = await rt.kb.search(String(params.query), {
          limit: typeof params.limit === "number" ? params.limit : 5,
        });
        return textResult({ results });
      },
    },
    { name: "cw_kb_search" },
  );

  api.registerTool(
    {
      name: "cw_query_objects",
      label: "Query ClaWorks objects",
      description: "Query ObjectStore by type name",
      parameters: Type.Object({
        type_name: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { items } = await rt.objectStore.query(String(params.type_name), {
          limit: typeof params.limit === "number" ? params.limit : 20,
        });
        return textResult({ type: params.type_name, items });
      },
    },
    { name: "cw_query_objects" },
  );

  api.registerTool(
    {
      name: "cw_list_playbooks",
      label: "List ClaWorks playbooks",
      description: "List loaded playbook definitions",
      parameters: Type.Object({}),
      async execute() {
        const rt = requireRuntime(getRuntime);
        return textResult({
          playbooks: rt.playbookEngine.list().map((p) => ({
            id: p.id,
            name: p.name,
            pack: p.pack,
            trigger: p.trigger,
          })),
        });
      },
    },
    { name: "cw_list_playbooks" },
  );

  api.registerTool(
    {
      name: "cw_write_playbook",
      label: "Write playbook YAML",
      description: "Write a playbook YAML file into the custom pack and reload packs",
      parameters: Type.Object({
        playbook_id: Type.String(),
        yaml: Type.String(),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        ensureCustomPackLayout();
        const id = String(params.playbook_id).replace(/[^\w-]/g, "_");
        const filePath = join(customPackRoot(), "ontology", "playbooks", `${id}.yaml`);
        writeFileSync(filePath, String(params.yaml), "utf8");
        const paths = new Set([...(rt.config.packs?.paths ?? []), customPackRoot()]);
        rt.config.packs = {
          ...rt.config.packs,
          paths: [...paths],
          installed: [...new Set([...(rt.config.packs?.installed ?? []), "custom"])],
        };
        await reloadClaworksPacksFromDisk(rt);
        return textResult({ status: "ok", path: filePath, playbook_id: id });
      },
    },
    { name: "cw_write_playbook" },
  );

  api.registerTool(
    {
      name: "cw_install_pack",
      label: "Install ClaWorks pack",
      description: "Install a pack from nexus://, file://, or local path",
      parameters: Type.Object({
        source: Type.String(),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const result = await installClaworksPack(rt, String(params.source));
        return textResult({
          pack_id: result.pack.manifest.id,
          version: result.pack.manifest.version,
          installed: result.installed,
        });
      },
    },
    { name: "cw_install_pack" },
  );

  api.registerTool(
    {
      name: "cw_define_object_type",
      label: "Define object type YAML",
      description: "Write an ObjectType YAML into the custom pack and reload ontology",
      parameters: Type.Object({
        type_name: Type.String(),
        yaml: Type.String(),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        ensureCustomPackLayout();
        const typeName = String(params.type_name).replace(/[^\w-]/g, "_");
        const dir = join(customPackRoot(), "ontology", "object_types");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${typeName}.yaml`), String(params.yaml), "utf8");
        const paths = new Set([...(rt.config.packs?.paths ?? []), customPackRoot()]);
        rt.config.packs = {
          ...rt.config.packs,
          paths: [...paths],
          installed: [...new Set([...(rt.config.packs?.installed ?? []), "custom"])],
        };
        await reloadClaworksPacksFromDisk(rt);
        return textResult({ status: "ok", type_name: typeName });
      },
    },
    { name: "cw_define_object_type" },
  );
}
