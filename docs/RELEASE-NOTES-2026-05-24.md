# ClaWorks Release Notes — 2026-05-24 / v2026.5.19

**产品版本**：`package.json` → `2026.5.19`  
**签收快照**：[`docs/SIGNOFF-SNAPSHOT.md`](SIGNOFF-SNAPSHOT.md)  
**验收清单**：[`docs/RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md)

---

## 摘要

本批次交付 **自学习 / 进化闭环** 与 **生产签收加固**：弱模型侧自动采集与沙盒回归，商业模型侧离线进化包生成，OT 连接器生产 guardrails，以及 `CLAWORKS_INIT_SECURE` 初始化路径。

---

## 自学习 / 进化里程碑

| 能力                            | 说明                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `autonomy.learn_opportunity` 链 | KB/CBR 写入、在线规则、知识缺口 → `evolution.simulation_requested`                                       |
| `EvolveEngine.proposeDraft`     | LLM 草稿 → KB `evolution_drafts`（`pending_review`，不自动部署）                                         |
| 沙盒导入                        | `importEvolutionPack({ sandbox })` + PlaybookSimulator → `evolution.sandbox_ready_for_promotion`（HITL） |
| Pending 持久化                  | SQLite 跨重启；`GET /v1/evolve/drafts`、`POST /v1/evolution/promote`                                     |
| 烟测                            | `pnpm claworks:evolution:smoke`（CI: `claworks-evolution-smoke.yml`）                                    |
| 弱模型回归                      | `pnpm claworks:weak-model-regression`（CI nightly）                                                      |
| 离线进化辅助                    | `pnpm claworks:evolution:export-helper` — 无 API Key 的 prompt + EvolutionPack 骨架                      |

---

## 生产 / OT 加固

- **Doctor**：`production_mode=true` 时 `simulate=true`、`*-simulate` preset、未知 preset → **error**
- **Doctor --fix**：剥离 simulate preset、`filesystem_kb` → `filesystem-kb` 等规范化
- **Init 警告**：`CLAWORKS_INIT_SECURE=1` 与 `production_mode` / `api_key` 不一致时提示
- **连接器文档**：[`connectors/README.md`](../connectors/README.md) 生产 checklist（mqtt/opcua/modbus）

---

## 质量门（签收时）

| 命令                              | 期望                      |
| --------------------------------- | ------------------------- |
| `pnpm claworks:runtime:test`      | 428/428 全绿              |
| `pnpm claworks:smoke`             | 27/27                     |
| `pnpm claworks:evolution:smoke`   | 进化链 + drafts + pending |
| `pnpm claworks:gateway:e2e`       | 预发布补跑                |
| `pnpm claworks:release:preflight` | tag 前预检                |

---

## Git tag（维护者，勿 force-push）

```bash
# 1. 预检（可选全量 gateway）
pnpm claworks:release:preflight
# CLAWORKS_PREFLIGHT_GATEWAY=1 pnpm claworks:release:preflight

# 2. 确认版本与 CHANGELOG（维护者 landing 时写入）
grep '"version"' package.json   # 期望 2026.5.19

# 3. 打 annotated tag（本地；push 需显式审批）
git tag -a v2026.5.19 -m "ClaWorks 2026.5.19 — auto-learning + production guardrails"

# 4. 推送 tag（非 force）
git push origin v2026.5.19
```

**Pack 仓**（sibling `claworks-packs`）：与主仓一并签收；引用 pack commit 见 `SIGNOFF-SNAPSHOT.md`。

---

## 仍须人工（上线前）

1. `CLAWORKS_INIT_SECURE=1 pnpm claworks:init --force` — 生产 token + `production_mode`
2. OT 实机关闭 simulate（见 connectors README checklist）
3. `CLAWORKS_PACKS_DIR` 指向有效 pack 仓 → `/v1/health` 期望 `status=ok`
4. 商业模型生成 EvolutionPack → `claworks evolution import`（或 sandbox + HITL promote）
