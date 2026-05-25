# ClaWorks WIP 清单

> 最后更新：2026-05-25（P2 生产交付收尾）  
> **分支**：`local/claworks-product`

## 已合入（P2 生产交付）

| 批次                     | 内容                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| OTEL 桥接                | EventKernel → `trace-otel-bridge` → `diagnostics-otel`（`b1c5d69d55`）                                       |
| OT dry-run + 生产配置    | `pnpm claworks:ot-dry-run` + `ot-production.claworks.fragment.json`（`b20cb8a315`）                          |
| OT 实机 runbook          | [`docs/claworks/ot-live.md`](docs/claworks/ot-live.md) + `pnpm claworks:ot-live-checklist` + env 校验 helper |
| GitHub branch protection | 文档 + `.github/branch-protection/claworks-main.json` + `pnpm claworks:branch-protection`                    |
| npm publish 预检         | dry-run + `pnpm claworks:npm-publish-checklist`                                                              |
| Feishu live E2E          | gate 单测（CI smoke）+ live 脚本 + [`docs/claworks/feishu-live-e2e.md`](docs/claworks/feishu-live-e2e.md)    |
| 弱模型 / 进化 CI         | PR + nightly workflows；branch protection 脚本待 admin `--apply`                                             |

## 已合入（早期批次）

| 批次                 | 内容                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| profile 原子切换     | `pack.load_profile_requested` → PackLoader 串行重载                           |
| W3C traceparent      | EventKernel → PlaybookRun → StepLog                                           |
| PlaybookMatcher 修复 | `evolution.simulation_requested` 不再语义误匹配 `weak_model_regression_suite` |
| evolve HITL          | 草稿 → 沙盒 → `evolution.promote_sandbox`                                     |
| 可观测性文档         | `docs/OBSERVABILITY.md`                                                       |

## B 类 — 明确不提交

| 路径                               | 说明       |
| ---------------------------------- | ---------- |
| `packages/claworks-runtime/dist/*` | 构建输出   |
| `.env` / credentials               | 密钥       |
| KB import 脚本（未纳入 P2）        | 待单独批次 |

## 阻塞 — 需人工（凭证 / 硬件 / 审批）

| 项                       | 状态     | 说明                                             |
| ------------------------ | -------- | ------------------------------------------------ |
| GitHub branch protection | **阻塞** | 脚本 dry-run 就绪；需 repo **admin** `--apply`   |
| npm 公开发布             | **阻塞** | dry-run/checklist 就绪；`@claworks` org + token  |
| Feishu 完整回环          | **阻塞** | ingress 探针就绪；需 `FEISHU_*` + webhook + 渠道 |
| OT 连接器实机            | **阻塞** | runbook/checklist 就绪；需现场 broker/PLC        |
| Studio React 编辑器      | **跳过** | 明确不在 P2 范围                                 |

## 当前验证命令

```bash
pnpm claworks:smoke
pnpm claworks:ot-dry-run
pnpm test test/scripts/claworks-feishu-live-e2e-gate.test.ts
pnpm test test/scripts/claworks-ot-connectivity-env.test.ts
pnpm test test/scripts/claworks-apply-branch-protection.test.ts
pnpm claworks:branch-protection              # dry-run
pnpm claworks:npm-publish-checklist
pnpm claworks:release:preflight
```

- **可观测性**：[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)
- **npm 发布**：[`docs/claworks/npm-publish.md`](docs/claworks/npm-publish.md)
- **签收**：[`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md) · [`docs/SIGNOFF-SNAPSHOT.md`](docs/SIGNOFF-SNAPSHOT.md)
