# ClaWorks WIP 清单

> 最后更新：2026-05-25  
> **分支**：`local/claworks-product`

## 已合入（近期批次）

| 批次                | 内容                                                           |
| ------------------- | -------------------------------------------------------------- |
| profile 原子切换    | `pack.load_profile_requested` → PackLoader 串行重载            |
| W3C traceparent     | EventKernel → PlaybookRun → StepLog                            |
| 弱模型 CI           | nightly + **PR pull_request** 触发                             |
| evolve HITL         | 草稿 → 沙盒 → `evolution.promote_sandbox`                      |
| auto_promote（dev） | `evolution.auto_promote_sandbox`（production_mode 强制 false） |
| 可观测性文档        | `docs/OBSERVABILITY.md`                                        |
| npm dry-run         | `pnpm claworks:runtime:publish:dry-run`                        |

## B 类 — 明确不提交

| 路径                               | 说明     |
| ---------------------------------- | -------- |
| `packages/claworks-runtime/dist/*` | 构建输出 |
| `.env` / credentials               | 密钥     |

## 待办（P2 — 需凭证/硬件/审批）

| 项                     | 说明                                  |
| ---------------------- | ------------------------------------- |
| Feishu live E2E        | 需 `FEISHU_APP_ID/SECRET` + 测试群    |
| OT 连接器实机          | MQTT broker / OPC UA 现场联调         |
| OTEL EventKernel 桥接  | diagnostics-otel span 与 runtime 统一 |
| npm 公开发布           | dry-run 就绪；组织审批 + npm org      |
| GitHub required checks | branch protection 启用弱模型 job      |
| Studio React 编辑器    | 全功能 UI 未做                        |

## 当前状态

- **测试**：`pnpm test packages/claworks-runtime`
- **可观测性**：见 [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)
