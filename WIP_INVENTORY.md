# ClaWorks WIP 清单

> 最后更新：2026-05-25  
> **分支**：`local/claworks-product`

## 已合入（近期批次）

| 批次                  | 内容                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| profile 原子切换      | `pack.load_profile_requested` → PackLoader 串行重载                                           |
| W3C traceparent       | EventKernel → PlaybookRun → StepLog                                                           |
| 弱模型 CI             | nightly + **PR pull_request** 触发                                                            |
| PlaybookMatcher 修复  | `evolution.simulation_requested` 不再语义误匹配 `weak_model_regression_suite`（`8ed05f2`）    |
| 进化链 smoke 断言     | `pnpm claworks:evolution:smoke` 断言 `weak_model_regression_suite` Playbook 完成（`6eaa339`） |
| 弱模型 regression E2E | `evolution.regression_requested` → capability 路由单测（`1dbb9a1`）                           |
| evolve HITL           | 草稿 → 沙盒 → `evolution.promote_sandbox`                                                     |
| auto_promote（dev）   | `evolution.auto_promote_sandbox`（production_mode 强制 false）                                |
| 可观测性文档          | `docs/OBSERVABILITY.md`                                                                       |
| OTEL 桥接             | EventKernel → `trace-otel-bridge` → `diagnostics-otel` span                                   |
| npm dry-run           | `pnpm claworks:publish:dry-run` + `pnpm claworks:runtime:publish:dry-run`                     |
| 发布前收尾            | runtime-store 加固、gateway e2e 全绿、`docs/claworks/install.md`、`pnpm claworks:ot-dry-run`  |
| GitHub required checks | `docs/GITHUB-BRANCH-PROTECTION.md`（维护者启用 branch protection）                           |
| OT 连接器生产         | `ot-production.claworks.fragment.json` + modbus dry-run + 单测                               |
| Feishu live E2E       | gate 单测 + `contrib/examples/feishu-live-e2e.env.example`；live 需凭证                      |

## B 类 — 明确不提交

| 路径                               | 说明     |
| ---------------------------------- | -------- |
| `packages/claworks-runtime/dist/*` | 构建输出 |
| `.env` / credentials               | 密钥     |

## 待办（需凭证/硬件/审批）

| 项                     | 说明                                  |
| ---------------------- | ------------------------------------- |
| Feishu live 回环       | 需 `FEISHU_*` + 公网 webhook + feishu 渠道 |
| OT 连接器实机          | MQTT broker / OPC UA / Modbus 现场联调 |
| npm 公开发布           | dry-run 就绪；组织审批 + npm org      |
| GitHub branch protection | 文档就绪；维护者在 Settings 启用 required checks |
| Studio React 编辑器    | 全功能 UI 未做（明确跳过）            |

## 当前状态

- **测试**：`pnpm claworks:smoke` + `pnpm claworks:gateway:e2e` + `pnpm test extensions/claworks-robot` → 签收前复跑
- **可观测性**：见 [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)
- **npm 发布**：见 [`docs/claworks/npm-publish.md`](docs/claworks/npm-publish.md)
