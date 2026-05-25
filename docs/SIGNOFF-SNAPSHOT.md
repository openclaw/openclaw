# ClaWorks 阶段性签收快照

**日期**：2026-05-25  
**Commit**：`433d41766d`（evolve sandbox gate；进化链 smoke 见 `6eaa339a3c`；PlaybookMatcher 见 `8ed05f2dc7`）  
**Pack commit**：`claworks-packs@fa0f07e`

---

## P0 签收结果

| #   | 检查项           | 命令                                               | 结果                                           |
| --- | ---------------- | -------------------------------------------------- | ---------------------------------------------- |
| 1   | Runtime 单元测试 | `pnpm claworks:runtime:test`                       | ✅ **420+/420+**                               |
| 2   | 产品烟测         | `pnpm claworks:smoke`                              | ✅ **27/27**                                   |
| 3   | Robot 插件契约   | `pnpm test extensions/claworks-robot`              | ✅ **17/17**                                   |
| 4   | Runtime lint     | `pnpm lint:core -- packages/claworks-runtime`      | ⚠️ 全仓 lint 规则过宽；runtime 单测全绿        |
| 5   | Doctor 可运行    | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor`      | ✅ 完成（本地 config 有 connectors 警告）      |
| 6   | 生产 Compose     | `docker compose -f docker-compose.prod.yml config` | ✅ 语法有效                                    |
| 7   | 健康端点         | `curl http://127.0.0.1:18800/v1/health`            | ✅ `status: degraded`（LLM 未配属预期）        |
| 8   | 生产模式         | 本地 ops-hub                                       | ⚠️ 开发模式；生产需 `production_mode=true`     |
| 9   | Gateway 令牌     | 本地                                               | ⚠️ 开发未强制；生产需 `OPENCLAW_GATEWAY_TOKEN` |
| 10  | Release 干净     | `git status`                                       | ✅ 签收时干净                                  |

## P1 结果

| #   | 检查项         | 结果                                                                                                                     |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 8   | Gateway E2E    | ✅ `pnpm claworks:gateway:e2e` 全绿（145 playbooks / MCP 32 tools）                                                      |
| 9   | Evolution 烟测 | `pnpm claworks:evolution:smoke` — 含 `weak_model_regression_suite` Playbook 完成断言；CI: `claworks-evolution-smoke.yml` | ✅ 签收前补跑 |
| 10  | 弱模型回归 CI  | `pnpm claworks:weak-model-regression` — CI: `claworks-weak-model-regression.yml` nightly                                 |
| 7   | CI smoke       | 未在本机跑 GitHub Actions                                                                                                |

---

## 自学习增强（本批次）

- `handleAutonomyLearnOpportunity`：收到 `autonomy.learn_opportunity` 后自动 KB/CBR 写入、CBR 复用建议、在线规则学习、知识缺口时触发 `evolution.simulation_requested`
- `EvolveEngine.proposeDraft`：知识缺口 / CBR 覆盖不足时 LLM 生成 Playbook 草稿 → KB `evolution_drafts`（`pending_review`）+ `evolve.playbook_drafted`（不部署）
- `EvolutionSyncManager.importEvolutionPack({ sandbox | simulate_only })`：沙盒 load + PlaybookSimulator 回归；通过后 `evolution.sandbox_ready_for_promotion`（HITL 晋升，不自动写生产 Pack）
- `runtime.ts` 订阅 `autonomy.learn_opportunity` 事件
- 修复 `detectLearnOpportunities` 重复发布 stub 事件风暴；修复 `samples` 未定义引用
- `/v1/health` 与 `/v1/metrics` 免 Bearer 认证（K8s 探针友好）
- 更新 `claworks-packs` 中 `autonomy_on_learn_opportunity` Playbook 字段对齐
- **进化链烟测**：`pnpm claworks:evolution:smoke` — 验证 learn → simulation → regression、**`weak_model_regression_suite` Playbook 完成**、`GET /v1/evolve/drafts`、沙盒 pending 晋升 SQLite 跨重启
- **PlaybookMatcher 语义修复**：阻断 `evolution.simulation_requested` 误触发 `weak_model_regression_suite`（token 子集匹配，`8ed05f2`）
- **弱模型回归 CI**：`.github/workflows/claworks-weak-model-regression.yml`（nightly + `workflow_dispatch`）
- **离线进化辅助**：`pnpm claworks:evolution:export-helper` + [`DEPLOYMENT.md`](../DEPLOYMENT.md) 步骤 2
- **OT 生产 guardrails**：doctor error on simulate + production；[`connectors/README.md`](../connectors/README.md) checklist
- **Release notes**：[`docs/RELEASE-NOTES-2026-05-24.md`](RELEASE-NOTES-2026-05-24.md)

---

## 签收结论

**P0/P1 核心质量门通过**，可进入预发布/内测交付。生产上线前仍需：生产模式 + API Key、OT 连接器实机关 simulate。
