# ClaWorks `cw_*` 工具矩阵

**更新**：2026-05-23  
**目的**：对齐 **宿主插件**（`claworks-robot`，48 工具）与 **远程桥**（`openclaw-claworks-extension`，22 工具）。

---

## 部署形态

| 形态               | 插件 ID          | 配置键                                  | 工具数 | 实现                       |
| ------------------ | ---------------- | --------------------------------------- | ------ | -------------------------- |
| 产品内置机器人     | `claworks-robot` | `plugins.entries.claworks-robot.config` | **48** | 进程内 `@claworks/runtime` |
| 官方 OpenClaw 远程 | `claworks`       | `plugins.entries.claworks.config`       | **22** | HTTP/MCP → 远程 Gateway    |

远程 22 工具是宿主 48 工具的**子集**（名称一致，无独有远程工具）。

---

## 远程桥工具（`openclaw-claworks-extension`，22）

| 工具                  | HTTP/MCP                       | 说明                  |
| --------------------- | ------------------------------ | --------------------- |
| `cw_instances`        | ✅                             | 多实例列表            |
| `cw_status`           | ✅ `/v1/health`                | 健康与 doctor 摘要    |
| `cw_doctor_run`       | ✅ POST `/v1/doctor/run`       | 诊断（无自动 fix）    |
| `cw_reload_packs`     | ✅                             | Pack 热重载           |
| `cw_reload_playbooks` | ✅                             | 刷新 YAML             |
| `cw_kb_search`        | ✅ MCP `search_kb`             | 知识检索              |
| `cw_kb_ingest`        | ✅                             | 快捷入库              |
| `cw_kb_ingest_folder` | ✅ POST `/v1/kb/ingest/folder` | 文件夹批量入库        |
| `cw_list_types`       | ✅ MCP                         | ObjectType 列表       |
| `cw_query_objects`    | ✅ MCP                         | 对象查询              |
| `cw_get_object`       | ✅                             | 单对象                |
| `cw_create_object`    | ✅                             | 创建                  |
| `cw_import_objects`   | ✅                             | 批量导入              |
| `cw_playbooks_list`   | ✅                             | Playbook 列表         |
| `cw_trigger_playbook` | ✅                             | 触发                  |
| `cw_playbook_runs`    | ✅                             | 运行记录              |
| `cw_hitl_pending`     | ✅ MCP                         | 待审批                |
| `cw_hitl_approve`     | ✅                             | 批准                  |
| `cw_hitl_reject`      | ✅                             | 拒绝                  |
| `cw_alarm_summary`    | ✅ MCP                         | 报警摘要              |
| `cw_agent_chat`       | ✅ POST `/v1/agent/chat`       | Agent 对话            |
| `cw_write_playbook`   | ✅                             | 写入 custom pack YAML |

契约测试：`openclaw-claworks-extension/extensions/claworks/canonical-surface.contract.test.ts`

---

## 仅宿主 robot（额外 26，无远程桥）

| 类别        | 工具                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份 / 事件 | `cw_get_identity`, `cw_publish_event`, `cw_bridge_im_message`, `cw_list_events`                                                                                                                     |
| KB 文档链   | `cw_kb_status`, `cw_kb_ingest_document`, `cw_kb_list_documents`, `cw_kb_get_document`, `cw_kb_lint_document`, `cw_kb_publish`, `cw_kb_create_ingest_job`, `cw_kb_process_ingest_job`, `cw_kb_flush` |
| 构建 / Pack | `cw_define_object_type`, `cw_install_pack`, `cw_evolution_export`, `cw_evolution_import`, `cw_evolution_status`                                                                                     |
| 连接器      | `cw_invoke_connector`                                                                                                                                                                               |
| 兼容别名    | `cw_list_playbooks`, `cw_list_runs`, `cw_list_hitl`, `cw_approve_hitl`, `cw_reject_hitl`, `cw_kernel_status`                                                                                        |

KB 文档链工具可通过 **REST `/v1/kb/*`** 直接调用；远程 extension 未暴露对应 `cw_*` 桥接。

---

## MCP stdio 服务（非 OpenClaw 插件工具面）

`packages/claworks-runtime/src/interfaces/mcp/tools.ts` 另暴露 MCP 名（如 `cw_health`, `cw_list_runs`），供 MCP 客户端使用，**不**映射到 extension manifest。

---

## 相关文档

- [IMPLEMENTATION-STATUS.md](./IMPLEMENTATION-STATUS.md) — Phase 与 MCP 清单
- [EXTERNAL-EXTENSION.md](./EXTERNAL-EXTENSION.md) — 外仓桥接
- `extensions/claworks-robot/openclaw.plugin.contract.test.ts` — 宿主 48 工具契约
