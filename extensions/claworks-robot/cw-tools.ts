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

  api.registerTool(
    {
      name: "cw_agent_chat",
      label: "Chat with ClaWorks agent",
      description:
        "通过 perceive.intent 能力将自然语言消息路由到机器人业务流程。" +
        "机器人会识别意图并触发对应的 Playbook 执行业务逻辑。",
      parameters: Type.Object({
        message: Type.String({ description: "用户消息文本" }),
        user_id: Type.Optional(Type.String({ description: "用户 ID（用于上下文与权限）" })),
        session_id: Type.Optional(Type.String({ description: "会话 ID（用于多轮对话追踪）" })),
        channel: Type.Optional(
          Type.String({ description: "来源渠道（feishu/weixin-work/cli 等）" }),
        ),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const result = await rt.kernel.callCapability(
          "perceive.intent",
          { source: "cw_agent_chat", subjectId: params.user_id ? String(params.user_id) : "agent" },
          {
            text: String(params.message),
            userId: params.user_id ? String(params.user_id) : undefined,
            sessionId: params.session_id ? String(params.session_id) : undefined,
            channel: params.channel ? String(params.channel) : "cli",
          },
        );
        return textResult(result);
      },
    },
    { name: "cw_agent_chat" },
  );

  api.registerTool(
    {
      name: "cw_kb_ingest",
      label: "Ingest text to KB",
      description: "将文本内容写入机器人知识库（支持命名空间和来源标记）",
      parameters: Type.Object({
        text: Type.String({ description: "要写入的文本内容" }),
        namespace: Type.Optional(
          Type.String({ description: "命名空间（用于隔离不同业务域的知识）" }),
        ),
        source: Type.Optional(Type.String({ description: "内容来源标识（文件路径、URL 等）" })),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        await rt.kb.ingest(String(params.text), {
          namespace: params.namespace ? String(params.namespace) : undefined,
          source: params.source ? String(params.source) : undefined,
        });
        return textResult({ status: "ok", chars: String(params.text).length });
      },
    },
    { name: "cw_kb_ingest" },
  );

  api.registerTool(
    {
      name: "cw_kb_status",
      label: "KB status",
      description: "返回知识库当前状态（提供者、文档数量、向量支持等）",
      parameters: Type.Object({}),
      async execute() {
        const rt = requireRuntime(getRuntime);
        if (rt.kb.describe) {
          return textResult(await rt.kb.describe());
        }
        return textResult({
          provider: "bm25-memory",
          vector: false,
          note: "in-memory BM25 KB; set kb_provider=memory-core for vector search",
        });
      },
    },
    { name: "cw_kb_status" },
  );

  api.registerTool(
    {
      name: "cw_kb_ingest_document",
      label: "Ingest document to KB",
      description: "将结构化文档写入知识库（支持分层、类型、自动发布）",
      parameters: Type.Object({
        text: Type.String({ description: "文档正文文本" }),
        title: Type.Optional(Type.String({ description: "文档标题" })),
        source: Type.Optional(Type.String({ description: "来源路径或 URL" })),
        namespace: Type.Optional(Type.String()),
        layer: Type.Optional(Type.String({ description: "知识层级 L0-L4" })),
        doc_type: Type.Optional(Type.String()),
        auto_publish: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          await rt.kb.ingest(String(params.text), {
            namespace: params.namespace ? String(params.namespace) : undefined,
            source: params.source ? String(params.source) : undefined,
          });
          return textResult({ status: "ok", note: "stored via basic ingest (no document KB)" });
        }
        const doc = await rt.kb.ingestDocument({
          text: String(params.text),
          title: params.title ? String(params.title) : undefined,
          source: params.source ? String(params.source) : undefined,
          namespace: params.namespace ? String(params.namespace) : undefined,
          layer: params.layer as "L0" | "L1" | "L2" | "L3" | "L4" | undefined,
          doc_type: params.doc_type ? String(params.doc_type) : undefined,
          auto_publish: params.auto_publish === true,
        });
        return textResult({ status: "ok", document: doc });
      },
    },
    { name: "cw_kb_ingest_document" },
  );

  api.registerTool(
    {
      name: "cw_kb_get_document",
      label: "Get KB document",
      description: "按 ID 获取知识库文档详情（包含所有分块）",
      parameters: Type.Object({
        document_id: Type.String({ description: "文档 ID" }),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ error: "document KB not available" });
        }
        const doc = await rt.kb.getDocument(String(params.document_id));
        return textResult({ document: doc });
      },
    },
    { name: "cw_kb_get_document" },
  );

  api.registerTool(
    {
      name: "cw_kb_list_documents",
      label: "List KB documents",
      description: "列出知识库文档（支持按状态、层级、命名空间过滤）",
      parameters: Type.Object({
        status: Type.Optional(
          Type.String({ description: "draft | reviewing | published | archived" }),
        ),
        layer: Type.Optional(Type.String()),
        namespace: Type.Optional(Type.String()),
        q: Type.Optional(Type.String({ description: "全文搜索关键词" })),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ documents: [], note: "document KB not available" });
        }
        const docs = await rt.kb.listDocuments({
          status: params.status as "draft" | "reviewing" | "published" | "archived" | undefined,
          layer: params.layer as "L0" | "L1" | "L2" | "L3" | "L4" | undefined,
          namespace: params.namespace ? String(params.namespace) : undefined,
          q: params.q ? String(params.q) : undefined,
          limit: typeof params.limit === "number" ? params.limit : 50,
        });
        return textResult({ documents: docs, count: docs.length });
      },
    },
    { name: "cw_kb_list_documents" },
  );

  api.registerTool(
    {
      name: "cw_kb_lint_document",
      label: "Lint KB document",
      description: "对知识库文档进行质量检查（内容完整性、格式规范等）",
      parameters: Type.Object({
        document_id: Type.String({ description: "文档 ID" }),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ ok: true, note: "lint not available (basic KB)" });
        }
        const result = await rt.kb.lintDocument(String(params.document_id));
        return textResult(result);
      },
    },
    { name: "cw_kb_lint_document" },
  );

  api.registerTool(
    {
      name: "cw_kb_publish",
      label: "Publish KB document",
      description: "将知识库文档状态从 draft/reviewing 变更为 published",
      parameters: Type.Object({
        document_id: Type.String({ description: "文档 ID" }),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ error: "document KB not available" });
        }
        const doc = await rt.kb.publishDocument(String(params.document_id));
        return textResult({ status: "published", document: doc });
      },
    },
    { name: "cw_kb_publish" },
  );

  api.registerTool(
    {
      name: "cw_kb_ingest_folder",
      label: "Ingest folder to KB",
      description: "批量将目录下的文件写入知识库（自动识别 Markdown/TXT/YAML）",
      parameters: Type.Object({
        folder_path: Type.String({ description: "要导入的目录路径" }),
        namespace: Type.Optional(Type.String()),
        layer: Type.Optional(Type.String()),
        doc_type: Type.Optional(Type.String()),
        auto_publish: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({
            error: "document KB not available; use cw_kb_ingest for basic ingest",
          });
        }
        const jobParams = {
          folder_path: String(params.folder_path),
          namespace: params.namespace ? String(params.namespace) : undefined,
          layer: params.layer as "L0" | "L1" | "L2" | "L3" | "L4" | undefined,
          doc_type: params.doc_type ? String(params.doc_type) : undefined,
          auto_publish: params.auto_publish === true,
        };
        const job = await rt.kb.createIngestJob(jobParams);
        const result = await rt.kb.processIngestJob(job.id);
        return textResult({ status: result.status, job: result });
      },
    },
    { name: "cw_kb_ingest_folder" },
  );

  api.registerTool(
    {
      name: "cw_kb_create_ingest_job",
      label: "Create KB ingest job",
      description: "创建知识库批量导入任务（异步执行，可通过 cw_kb_process_ingest_job 推进）",
      parameters: Type.Object({
        folder_path: Type.Optional(Type.String()),
        source_path: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        source: Type.Optional(Type.String()),
        namespace: Type.Optional(Type.String()),
        layer: Type.Optional(Type.String()),
        doc_type: Type.Optional(Type.String()),
        auto_publish: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ error: "document KB not available" });
        }
        const job = await rt.kb.createIngestJob({
          folder_path: params.folder_path ? String(params.folder_path) : undefined,
          source_path: params.source_path ? String(params.source_path) : undefined,
          text: params.text ? String(params.text) : undefined,
          title: params.title ? String(params.title) : undefined,
          source: params.source ? String(params.source) : undefined,
          namespace: params.namespace ? String(params.namespace) : undefined,
          layer: params.layer as "L0" | "L1" | "L2" | "L3" | "L4" | undefined,
          doc_type: params.doc_type ? String(params.doc_type) : undefined,
          auto_publish: params.auto_publish === true,
        });
        return textResult({ job_id: job.id, status: job.status });
      },
    },
    { name: "cw_kb_create_ingest_job" },
  );

  api.registerTool(
    {
      name: "cw_kb_process_ingest_job",
      label: "Process KB ingest job",
      description: "执行已创建的知识库导入任务，返回处理报告",
      parameters: Type.Object({
        job_id: Type.String({ description: "由 cw_kb_create_ingest_job 返回的 job_id" }),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ error: "document KB not available" });
        }
        const result = await rt.kb.processIngestJob(String(params.job_id));
        return textResult({ status: result.status, report: result.report, job: result });
      },
    },
    { name: "cw_kb_process_ingest_job" },
  );

  api.registerTool(
    {
      name: "cw_kb_flush",
      label: "Flush KB drop dir",
      description: "将 kb-drop 目录中的待处理文件批量导入知识库",
      parameters: Type.Object({
        namespace: Type.Optional(Type.String({ description: "仅处理指定命名空间的文件" })),
      }),
      async execute(_id, params) {
        const rt = requireRuntime(getRuntime);
        const { isDocumentKnowledgeBase } = await import("@claworks/runtime");
        if (!isDocumentKnowledgeBase(rt.kb)) {
          return textResult({ error: "document KB not available; drop files require document KB" });
        }
        const ns = params.namespace ? String(params.namespace) : undefined;
        const job = await rt.kb.createIngestJob({ namespace: ns });
        const result = await rt.kb.processIngestJob(job.id);
        return textResult({ status: result.status, report: result.report });
      },
    },
    { name: "cw_kb_flush" },
  );
}
