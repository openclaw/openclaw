# ClaWorks `cw_*` 工具矩阵

**更新**：2026-05-20  
**目的**：对齐 **宿主插件**（`claworks-robot`）与 **远程桥**（`extensions/claworks` / `openclaw-claworks-extension`）的工具命名与语义。

---

## 部署形态

| 形态               | 插件 ID          | 配置键                                  | 实现                       |
| ------------------ | ---------------- | --------------------------------------- | -------------------------- |
| 产品内置机器人     | `claworks-robot` | `plugins.entries.claworks-robot.config` | 进程内 `@claworks/runtime` |
| 官方 OpenClaw 远程 | `claworks`       | `plugins.entries.claworks.config`       | HTTP/MCP → 远程 Gateway    |

---

## 工具对照表

| 工具                       | 远程桥                                   | 宿主 robot              | 说明                           |
| -------------------------- | ---------------------------------------- | ----------------------- | ------------------------------ |
| `cw_status`                | ✅ HTTP `/v1/health`                     | ✅ `buildHealthPayload` | 健康与 doctor 检查             |
| `cw_doctor_run`            | ✅ POST `/v1/doctor/run`                 | ✅ `runClaworksDoctor`  | 宿主 `fix` 暂未自动修复        |
| `cw_instances`             | ✅ 多实例列表                            | ✅ 单实例 `local`       | 宿主仅嵌入式 monolith          |
| `cw_reload_packs`          | ✅                                       | ✅                      | Pack 热重载                    |
| `cw_reload_playbooks`      | ✅                                       | ✅                      | 同 reload packs（刷新 YAML）   |
| `cw_kb_status`             | ✅ GET `/v1/kb/status`                   | ✅                      | provider / vector / embed      |
| `cw_kb_search`             | ✅ MCP `search_kb`                       | ✅                      | 可选 `namespace`、`layer`      |
| `cw_kb_ingest`             | ✅                                       | ✅                      | 快捷入库（auto-publish）       |
| `cw_kb_ingest_document`    | ✅ POST `/v1/kb/documents`               | ✅                      | Twin 文档层 draft/publish      |
| `cw_kb_list_documents`     | ✅ GET `/v1/kb/documents`                | ✅                      | 按 status/layer/namespace 过滤 |
| `cw_kb_get_document`       | ✅ GET `/v1/kb/documents/:id`            | ✅                      | 含 chunks                      |
| `cw_kb_lint_document`      | ✅ POST `/v1/kb/documents/:id/lint`      | ✅                      | Refinery 质检                  |
| `cw_kb_publish`            | ✅ POST `/v1/kb/documents/:id/publish`   | ✅                      | lint 通过后发布                |
| `cw_kb_create_ingest_job`  | ✅ POST `/v1/kb/ingest/jobs`             | ✅                      | 批量 job 排队                  |
| `cw_kb_process_ingest_job` | ✅ POST `/v1/kb/ingest/jobs/:id/process` | ✅                      | 执行 job                       |
| `cw_kb_ingest_folder`      | ✅ POST `/v1/kb/ingest/folder`           | ✅                      | 结束后 auto flush              |
| `cw_kb_flush`              | ✅ POST `/v1/kb/flush`                   | ✅                      | memory-core 强制 sync          |
| `cw_list_types`            | ✅ MCP `list_object_types`               | ✅                      |                                |
| `cw_query_objects`         | ✅ MCP `query_objects`                   | ✅ 含 `filters`         |                                |
| `cw_get_object`            | ✅                                       | ✅                      |                                |
| `cw_create_object`         | ✅                                       | ✅                      |                                |
| `cw_import_objects`        | ✅                                       | ✅                      | 批量 create                    |
| `cw_playbooks_list`        | ✅                                       | ✅                      | 推荐名                         |
| `cw_list_playbooks`        | —                                        | ✅                      | 宿主别名，保留兼容             |
| `cw_playbook_runs`         | ✅                                       | ✅                      |                                |
| `cw_trigger_playbook`      | ✅                                       | ✅                      |                                |
| `cw_hitl_pending`          | ✅ MCP `list_pending_hitl`               | ✅                      |                                |
| `cw_hitl_approve`          | ✅ POST `.../approve`                    | ✅ 可省略 `step_id`     |                                |
| `cw_hitl_reject`           | ✅ POST `.../reject`                     | ✅                      |                                |
| `cw_alarm_summary`         | ✅ MCP `get_alarm_summary`               | ✅                      | 需 ontology `Alarm` 类型       |
| `cw_agent_chat`            | ✅ POST `/v1/agent/chat`                 | ✅ 需 OpenClaw LLM      |                                |

## 仅宿主（构建 / 运维）

| 工具                    | 说明                   |
| ----------------------- | ---------------------- |
| `cw_get_identity`       | 机器人身份与 Pack 概要 |
| `cw_bridge_im_message`  | IM → Ingress           |
| `cw_publish_event`      | 经 Ingress 发布事件    |
| `cw_write_playbook`     | 写入 custom pack YAML  |
| `cw_define_object_type` | 写入 ObjectType YAML   |
| `cw_install_pack`       | Nexus / 本地 Pack 安装 |

---

## MCP JSON-RPC 别名（远程桥 invoke 名）

宿主 Gateway 的 `POST /mcp` `tools/call` 同时支持：

- `list_pending_hitl` → 等同 `cw_hitl_pending` 语义
- `get_alarm_summary`
- `list_object_types`
- `search_kb`
- `query_objects`

实现：`packages/claworks-runtime/src/interfaces/mcp/tools.ts` → `callClaworksMcpTool`。

---

## 相关文档

- `extensions/claworks-robot/skills/claworks-robot-host/SKILL.md`
- `EXTERNAL-EXTENSION.md` — 官方 OpenClaw 远程扩展
- `IMPLEMENTATION-STATUS.md` — 实现状态
