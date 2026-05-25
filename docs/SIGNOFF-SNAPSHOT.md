# ClaWorks 阶段性签收快照

**日期**：2026-05-25  
**分支**：`local/claworks-product`  
**Pack commit**：`claworks-packs@fa0f07e`（签收时引用）

---

## P0 签收结果

| #   | 检查项           | 命令                                               | 结果                                     |
| --- | ---------------- | -------------------------------------------------- | ---------------------------------------- |
| 1   | Runtime 单元测试 | `pnpm claworks:runtime:test`                       | ✅ **420+/420+**                         |
| 2   | 产品烟测         | `pnpm claworks:smoke`                              | ✅ **27/27**                             |
| 3   | Robot 插件契约   | `pnpm test extensions/claworks-robot`              | ✅ **19/19**                             |
| 4   | Runtime lint     | `pnpm lint:core -- packages/claworks-runtime`      | ✅ 0 error（收窄 runtime 包）            |
| 5   | Doctor 可运行    | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor`      | ✅                                       |
| 6   | 生产 Compose     | `docker compose -f docker-compose.prod.yml config` | ✅ 语法有效                              |
| 7   | 健康端点         | `curl http://127.0.0.1:18800/v1/health`            | ⚠️ 需 `CLAWORKS_PACKS_DIR` → `status=ok` |
| 8   | 生产模式         | 单测 + repair                                      | ⚠️ 生产需 `production_mode=true`         |
| 9   | Gateway 令牌     | `CLAWORKS_INIT_SECURE=1`                           | ⚠️ 生产需 secure init                    |
| 10  | Release 干净     | `git status`                                       | ✅ 签收批次分组 commit                   |

## P1 结果

| #   | 检查项         | 结果                                                        |
| --- | -------------- | ----------------------------------------------------------- |
| 8   | Gateway E2E    | ✅ `pnpm claworks:gateway:e2e`                              |
| 9   | Evolution 烟测 | ✅ `pnpm claworks:evolution:smoke`                          |
| 10  | 弱模型回归 CI  | ✅ `claworks-weak-model-regression.yml`                     |
| 7   | CI smoke       | ✅ `claworks-smoke.yml`（含 OT dry-run + Feishu gate 单测） |

---

## P2 生产交付（2026-05-25）

| 项                       | 交付物                                                                 | 自动化状态        | 人工阻塞             |
| ------------------------ | ---------------------------------------------------------------------- | ----------------- | -------------------- |
| OTEL 桥接                | `trace-otel-bridge` + observation 事件                                 | ✅ 已合入         | —                    |
| OT dry-run / 生产        | `pnpm claworks:ot-dry-run` + doctor guardrails                         | ✅ CI + 本地      | 实机 hardware        |
| OT 实机 runbook          | `docs/claworks/ot-live.md` + `pnpm claworks:ot-live-checklist`         | ✅ 只读 checklist | 现场联调             |
| GitHub branch protection | `docs/GITHUB-BRANCH-PROTECTION.md` + `pnpm claworks:branch-protection` | ✅ dry-run 脚本   | repo admin `--apply` |
| npm publish              | dry-run + `pnpm claworks:npm-publish-checklist`                        | ✅ verify 脚本    | `@claworks` org      |
| Feishu live E2E          | gate 单测 + `pnpm claworks:feishu:live-e2e` + runbook                  | ✅ ingress 探针   | 凭证 + webhook 回环  |
| Studio                   | —                                                                      | ⏭ **跳过**       | —                    |

---

## 签收结论

**P0/P1/P2 自动化与文档交付完成**，可进入预发布/内测。生产上线前仍需：secure init + 生产模式、branch protection admin 应用、npm org 审批、OT 实机、Feishu 完整回环（若启用飞书渠道）。
