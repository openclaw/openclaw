# ClawTwin Phase A 测试验收记录

> **性质**：M0–M1.7 交付认定与可重复验证依据  
> **代码真源**：`clawtwin-platform/platform-api/`  
> **清单真源**：`CLAWTWIN-MILESTONE-PLAN.md` §「Phase A 验收清单（优化版）」

### 范围：只有 Platform，还是含 Studio？

| 层级                     | 仓库 / 路径                                            | Phase A 是否纳入自动化验收                                                                            |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Platform API**         | `clawtwin-platform/platform-api/`                      | **是** — `phase_a_acceptance.sh` / `pytest tests/`                                                    |
| **Studio（运营工作台）** | `clawtwin-studio/`（独立前端，如 Vite/Tauri monorepo） | **否** — 里程碑明确 Phase A **不做** 生产级 Studio UI；**M5（Phase C）** 再作为 Studio 交付与联调验收 |

**说明**：Phase A 的「运营闭环」已通过 **飞书 HITL 卡片 + MCP 平台工具 + REST/SSE** 提供最小可用交互；Studio 与 Platform 的 **联合烟测 / E2E** 可作为 Phase B+ 或 M5 的前置条目单独立项，**不替代** 本文件的 Platform pytest 门禁。

---

## 1. 自动化验收（必过）

在 `platform-api` 根目录执行：

```bash
uv sync --extra dev   # 首次或未装依赖
uv run pytest tests/ -q
# 或减少 skipped（需网络拉取可选依赖）：
# ./scripts/phase_a_acceptance.sh --full
```

**GitHub（`clawtwin-platform` 仓库）**：推送/PR 若触及 `platform-api/**`，Actions 跑 **Phase B**；**Phase A full**（等同 **`phase_a_acceptance.sh --full`**）在 **PR 合并目标为 `main`/`master`** 或 **push 到该分支** 时另跑。见 **`.github/workflows/README.md`**。

**最近一次记录（CI / 本地同款命令）**

| 指标 | 结果                          |
| ---- | ----------------------------- |
| 通过 | 377                           |
| 跳过 | 2（环境相关，见 pytest 输出） |
| 失败 | 0                             |

**等价一键脚本**：`scripts/phase_a_acceptance.sh`；**尽量少 skip**：`./scripts/phase_a_acceptance.sh --full`（等价于先 `uv sync --extra dev --extra linkml --extra casbin`）。

### 1.1 可选依赖：减少 skipped（非 Phase A 必装）

仅 `dev` 时 pytest 常见 **2 skipped**（**不阻塞** Phase A 认定）：

| 测试                              | 原因                  | 安装                                 |
| --------------------------------- | --------------------- | ------------------------------------ |
| `test_marking.py`（部分）         | 未装 casbin           | `uv sync --extra dev --extra casbin` |
| `test_ontology_loader.py`（部分） | 未装 `linkml-runtime` | `uv sync --extra dev --extra linkml` |

可同时安装：`uv sync --extra dev --extra linkml --extra casbin`。安装后通常为 **378 passed, 1 skipped**（余下 1 条为 **有 linkml 时按设计跳过**的另一分支用例，见 `test_ontology_loader.py` 内说明）。

---

## 2. 清单项 ↔ 证据映射

| #   | 验收项                                              | 自动化证据                                                                                                               | 说明                                      |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1   | `dispatch(PlatformEvent)` 单列入口                  | `tests/test_event_dispatcher_feishu_outbox.py` 等；`_KNOWN_TYPES` 见 `infra/event_dispatcher.py`                         | 新事件类型须先入注册表                    |
| 2   | Feishu HITL 卡片 + webhook                          | `tests/test_feishu_webhook.py`、`infra/feishu_card.py`、`apps/http/routes/feishu_webhook.py`                             | 手工：Lark 后台配置 Request URL           |
| 3   | Feishu channel Outbox + fanout                      | `tests/test_event_dispatcher_feishu_outbox.py`；`workers/outbox_dispatcher.py` `handled_types`                           |                                           |
| 4   | `playbook_run.notification` 与 HITL 同链            | 同上 + `core/playbook_engine/executor.py` `_execute_notification_step`                                                   | Feishu 走 `dispatch`，非直连              |
| 5   | Webhook Outbox `commit`                             | `infra/event_dispatcher.py` `_WebhookOutboxSink`                                                                         |                                           |
| 6   | `POST /v1/webhooks/dispatch` 入队                   | `tests/test_webhooks_route.py`                                                                                           |                                           |
| 7   | `clawtwin` CLI + 生命周期                           | `tests/test_cli_start.py`；`apps/cli/main.py`、`apps/http/main.py`                                                       | `uv run clawtwin --help`                  |
| 8   | Doctor / Health / `worker_heartbeats`               | `tests/test_health*.py`、`tests/test_worker_heartbeat_db.py`、`infra/doctor/`、`infra/health/`                           | DB 镜像：`CLAWTWIN_WORKER_HEARTBEAT_DB=1` |
| 9   | MCP 平台工具 x3                                     | `aip/mcp_server.py`；`tests/test_mcp_tools_http.py`（manifest）；`tests/test_mcp_http_stub.py`（`get_alarm_summary` 等） | 名称含于 `get_mcp_tool_manifest`          |
| 10  | create_work_order / 无 handler 报错 / reject→cancel | `tests/test_action_executor*.py`、`tests/test_hitl_workorders.py`、`core/extension_registry/builtin.py`                  |                                           |

---

## 3. 预发 / 生产类手工项（Phase A 不阻塞代码认定，上线前勾选）

| 项             | 操作                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 飞书 Event URL | `https://<host>/v1/feishu/events`；配置 `CLAWTWIN_FEISHU_CARD_SECRET`                    |
| 真实 LLM       | 配置 `OPENAI_API_KEY` 或对应 Provider，跑一条 `diagnose_equipment`（可选）               |
| OPC-UA 模拟器  | `CLAWTWIN_OPCUA_ENABLED=1` + 标签 JSON；属 M2 加压场景，Phase A 以 Worker 与迁移存在为准 |

---

## 4. 结论与签收

- **Phase A 代码侧**：以 **§1 自动化验收全绿** 为通过准则。
- **Phase B 起点**：`CLAWTWIN-MILESTONE-PLAN.md` **M2**（真实数据接入与加压验收），并按该文档 **「M2 启动清单」** 排第一条迭代。自动化门禁：**`clawtwin-platform/platform-api/scripts/m2_acceptance.sh`**（M2 子集 + 可选 `--live`）；**M2+M3 合并**：**`clawtwin-platform/platform-api/scripts/phase_b_acceptance.sh`**（依次跑 M2 与 `m3_smoke`）。

| 角色 | 姓名 | 日期 | 签字 |
| ---- | ---- | ---- | ---- |
| 开发 |      |      |      |
| QA   |      |      |      |

---

_路径：`contrib/industrial-oilgas-skills/CLAWTWIN-PHASE-A-ACCEPTANCE.md`_
