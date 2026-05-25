# ClaWorks Release Checklist

**用途**：客户交付 / 生产签收前的验收清单。  
**更新**：2026-05-25（P1 签收验证：P0 #7–#9 运行态 + evolution/ot-dry-run/audit）  
**相关文档**：[`CUSTOMER-DELIVERY.md`](CUSTOMER-DELIVERY.md)、[`OPERATOR-CHECKLIST.md`](OPERATOR-CHECKLIST.md)、[`DEPLOYMENT.md`](../DEPLOYMENT.md)、[`PRODUCTION-READINESS.md`](design/PRODUCTION-READINESS.md)、[`QUICKSTART.md`](../QUICKSTART.md)

---

## 1. 交付制品清单

| 制品                      | 路径 / 说明                                                   | 必须 |
| ------------------------- | ------------------------------------------------------------- | :--: |
| 主仓源码或镜像            | `claworks` git bundle / `claworks:TAG` Docker 镜像            |  ✅  |
| Pack 仓                   | sibling `claworks-packs` 或 Nexus 挂载目录                    |  ✅  |
| 环境变量模板              | `.env.example`（含 ClaWorks 变量）                            |  ✅  |
| 生产 Compose              | `docker-compose.prod.yml`                                     |  ✅  |
| 生产配置片段              | `contrib/examples/claworks-production.openclaw.fragment.json` |  ✅  |
| API 规范                  | `docs/design/API-SPEC.md`                                     |  ✅  |
| 许可证                    | `LICENSE` + `LICENSE-COMMERCIAL.md`                           |  ✅  |
| OpenClaw 桥接扩展（可选） | `openclaw-claworks-extension`                                 | 按需 |
| 客户交付指南              | `docs/CUSTOMER-DELIVERY.md`                                   |  ✅  |

---

## 2. P0 签收前检查（必须通过）

| #   | 检查项            | 命令 / 证据                                                                        | 状态 |
| --- | ----------------- | ---------------------------------------------------------------------------------- | ---- |
| 1   | Runtime 单元测试  | `pnpm claworks:runtime:test` → 全绿                                                | ✅   |
| 2   | 产品烟测          | `pnpm claworks:smoke` → 全绿                                                       | ✅   |
| 3   | Robot 插件契约    | `pnpm test extensions/claworks-robot` → 19/19（含 runtime-store 双重注册）         | ✅   |
| 4   | Runtime lint/类型 | `pnpm lint:core -- packages/claworks-runtime` → 0 error                            | ✅   |
| 5   | Doctor 可运行     | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor` → 无阻塞 Invalid config              | ✅   |
| 6   | 生产 Compose 有效 | `docker compose -f docker-compose.prod.yml config`                                 | ✅   |
| 7   | 健康端点          | `curl -s http://127.0.0.1:18800/v1/health` → 可达；`planes.*=ok`；无 `error` check | ✅   |
| 8   | 生产模式          | `production_mode: true` fail-closed（单测 + repair）；本地 dev 未启用              | ✅   |
| 9   | Gateway 令牌      | `CLAWORKS_INIT_SECURE=1` 写入 api_key + gateway token；REST 401/200 验证           | ✅   |
| 10  | Release 干净      | `git status` 无未提交阻塞项；已打 tag                                              | ✅   |

### P0 备注（2026-05-25）

- **#4 lint**：`pnpm lint:core -- packages/claworks-runtime` 经 `--` 收窄至 runtime 包；plugin-sdk boundary dts + oxlint 风格规则 0 error。全仓 `src ui packages` 无 `--` 收窄时仍有历史 type-aware 债务（非 P0 阻塞）。
- **#5 doctor**：`filesystem-kb` 已加入 robot 插件 schema enum 与 `presets.ts` resolver；需 `pnpm build` 刷新 `dist/extensions/claworks-robot/openclaw.plugin.json` 后 doctor 才读新 schema。
- **#7 健康（2026-05-25）**：本地 Gateway `:18800` 已运行。`GET /v1/health` → `200`，`status=degraded`（仅 `packs_source: warn`，`planes.kernel/data/orch=ok`）；`GET /v1/metrics` → Prometheus 文本 `200`；`POST /v1/doctor` → `200` JSON checks。`pnpm claworks:smoke` 27/27 通过。**生产签收期望 `status=ok`**：设置 `CLAWORKS_PACKS_DIR` 指向有效 pack 仓（sibling `../claworks-packs` 或 Nexus 挂载），并 `pnpm claworks:repair` / `claworks doctor --fix` 启用 robot + packs。示例：
  ```bash
  export CLAWORKS_PACKS_DIR=/path/to/claworks-packs
  pnpm claworks:repair && claworks gateway restart
  curl -s http://127.0.0.1:18800/v1/health | jq '.status,.checks.packs_source'
  ```
- **#8 生产模式（2026-05-25）**：契约单测通过 — `step-executor.production.test.ts`（llm/skill/subagent fail-closed）、`product-config-repair.test.ts`（simulate preset 剥离、echo 禁用）。**P2 修复**：`CLAWORKS_INIT_SECURE=1 node scripts/claworks-init.mjs` 默认禁用 echo（与 production fragment 对齐）。生产：`CLAWORKS_INIT_SECURE=1 pnpm claworks:init` 或 fragment 中 `production_mode: true`。
- **#9 令牌（2026-05-25）**：临时目录 `CLAWORKS_INIT_SECURE=1 node scripts/claworks-init.mjs` 生成 api_key + `gateway.auth.token`；in-process REST：`/v1/health` 无 Bearer → `200`；`/v1/identity` 无/错 Bearer → `401`；正确 Bearer → `200`。修复 `matchesKey` 对 32 字符 plaintext key 的误判。本地长期 Gateway 仍无 api_key（dev 开放）— 签收前需 secure init。MCP RBAC 单测：`mcp-auth.test.ts` 5/5。
- **#10 Release（2026-05-25）**：`package.json` 版本 `2026.5.19`；P0 验收全绿（runtime test 420+/420+、smoke 27/27、lint 0 error、doctor 无阻塞 Invalid config）；工作区已分组 conventional commit；本地 tag `v2026.5.19`（未 push）。打 tag 步骤见 [`RELEASE-NOTES-2026-05-24.md`](RELEASE-NOTES-2026-05-24.md)。
- **#7–#9 运行态补验（2026-05-25）**：临时目录 `CLAWORKS_PACKS_DIR=/Users/power/Projects/claworks-packs` + `CLAWORKS_INIT_SECURE=1 node scripts/claworks-init.mjs` → `production_mode=true`、`require_api_key=true`、api_key 32 字符、`connectors.echo.enabled=false`（P2 修复）。禁用 echo 后 Gateway 冷启动 ~100s：`GET /v1/health` → `200`，`status=degraded`（仅 warn：LLM/Notify/PG/A2A/connectors），`planes.kernel/data/orch=ok`，无 error check。若保留 echo → `connectors_echo_demo:error` → `status=unavailable`（fail-closed 符合预期）。REST：`/v1/identity` 无/错 Bearer → `401`，正确 Bearer → `200`；`/v1/health` 无 token → `200`。生产单测 446/446。**P2**：`pnpm claworks:repair` 恢复（`defaultClaworksStateDir` 导出）。详见 [`CUSTOMER-DELIVERY.md`](CUSTOMER-DELIVERY.md)。

---

## 3. P1 强烈建议（生产加固）

| #   | 检查项         | 说明                                                                                                                                                   | 状态 |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1   | PostgreSQL     | `DATABASE_URL=postgresql://...` + `pnpm claworks:migrate`                                                                                              | ☐    |
| 2   | OT 连接器实机  | 关闭 `simulate`；mqtt/opcua/modbus 现场联调报告（见 [`QUICKSTART.md`](../QUICKSTART.md#ot-连接器实机验证预生产)）；dry-run：`pnpm claworks:ot-dry-run` | ⚠️   |
| 3   | 依赖 audit     | `pnpm audit --registry=https://registry.npmjs.org` 或 SBOM                                                                                             | ⚠️   |
| 4   | Extension 裁剪 | `pnpm claworks:prune-extensions:apply`（生产白名单）                                                                                                   | ☐    |
| 5   | 备份策略       | `ecosystem-backup.sh` + `claworks-data` 卷定期备份                                                                                                     | ☐    |
| 6   | 监控           | Prometheus scrape `/v1/metrics`；OTEL 可选                                                                                                             | ☐    |
| 7   | CI 绿          | `.github/workflows/claworks-smoke.yml` 在 release 分支通过                                                                                             | ☐    |
| 8   | Gateway E2E    | `pnpm claworks:gateway:e2e`（本地/预发布；2026-05-25 回归全绿）                                                                                        | ✅   |
| 9   | Evolution 烟测 | `pnpm claworks:evolution:smoke`（进化链 + `weak_model_regression_suite` 完成 + drafts REST + pending 持久化）                                          | ✅   |

### P1 备注（2026-05-25 签收验证）

- **#2 OT**：`pnpm claworks:ot-dry-run` → ALL OT DRY-RUN CHECKS PASSED（mqtt/opcua simulate）。实机关 `simulate` 仍待现场报告 → ⚠️。
- **#3 audit**：`pnpm audit --registry=https://registry.npmjs.org` → **2 moderate**（`protobufjs`、`qs` 传递依赖）→ ⚠️ accepted risk，待上游 bump；不阻塞 P0/P1 签收。
- **#9 evolution**：`CLAWORKS_PACKS_DIR=…/claworks-packs pnpm claworks:evolution:smoke` → ALL EVOLUTION CHAIN CHECKS PASSED。
- **#6 compose**：`docker compose -f docker-compose.prod.yml config` → 语法有效（P0 #6 已覆盖）。
- **签收文档**：[`CUSTOMER-DELIVERY.md`](CUSTOMER-DELIVERY.md)。

### Gateway E2E 与 CI

- **脚本**：`pnpm claworks:gateway:e2e`（`scripts/claworks-gateway-e2e.mjs`）会启动真实 Gateway 并探测 `/v1` 与 MCP。
- **进化链烟测**：`pnpm claworks:evolution:smoke`（`scripts/claworks-evolution-chain-smoke.mjs`）验证 `autonomy.learn_opportunity` → `evolution.simulation_requested` → `evolution.regression_requested`、**`weak_model_regression_suite` Playbook 完成**、`GET /v1/evolve/drafts`、沙盒 pending 晋升 SQLite 持久化。CI：`.github/workflows/claworks-evolution-smoke.yml`（`workflow_dispatch` + 每周日 schedule；进化相关 PR 路径触发）。
- **弱模型回归**：`pnpm claworks:weak-model-regression`；CI：`.github/workflows/claworks-weak-model-regression.yml`（`workflow_dispatch` + 每日 nightly + 相关 PR 路径）。
- **当前 CI**：`.github/workflows/claworks-smoke.yml` 仅跑 `pnpm claworks:smoke`（无 live gateway）；release 分支签收前请在 Testbox/本机补跑 gateway e2e 与 evolution smoke。
- **后续（P2+）**：若需进默认 PR 路径，保持 evolution/weak-model 为 optional job，避免每次 PR 起 Gateway 或全量回归。

---

## 4. 标准验收命令（复制执行）

```bash
cd claworks

# 构建 runtime dist（doctor / 运行时 import 依赖）
pnpm claworks:runtime:build
pnpm build   # 刷新 bundled plugin schema（含 filesystem-kb preset）

# 质量门
pnpm lint:core -- packages/claworks-runtime
pnpm claworks:runtime:test
pnpm test extensions/claworks-robot
pnpm claworks:smoke

# 真实 Gateway 闭环（预发布 / 签收前；约 2–5 分钟）
pnpm claworks:gateway:e2e

# 进化链烟测（进程内；约 1–3 分钟；需 sibling claworks-packs 或 CLAWORKS_PACKS_DIR）
pnpm claworks:evolution:smoke

# 弱模型回归套件（可选；CI nightly / workflow_dispatch）
pnpm claworks:weak-model-regression

# OT 模拟连接器（无实机）
pnpm claworks:ot-dry-run

# 打 tag 前预检（默认跳过 gateway/evolution；全量见下行）
pnpm claworks:release:preflight
CLAWORKS_PREFLIGHT_EVOLUTION=1 CLAWORKS_PREFLIGHT_GATEWAY=1 pnpm claworks:release:preflight

# Branch protection / Release notes: docs/GITHUB-BRANCH-PROTECTION.md  docs/RELEASE-NOTES-2026.5.19.md

# 产品诊断
CLAWORKS_INIT_SECURE=1 pnpm claworks:init   # 首次
CLAWORKS_PRODUCT=1 node claworks.mjs doctor

# 部署语法
docker compose -f docker-compose.prod.yml config

# 运行中健康（需 gateway 已启动）
curl -s http://127.0.0.1:18800/v1/health | head -c 400; echo
curl -s http://127.0.0.1:18800/v1/metrics | head -5
curl -s -X POST http://127.0.0.1:18800/v1/doctor | head -c 400; echo

# 生产令牌（临时目录示例，不污染 ~/.claworks）
# OPENCLAW_STATE_DIR=/tmp/claworks-secure-test/state CLAWORKS_INIT_SECURE=1 node scripts/claworks-init.mjs
```

**扩展仓（OpenClaw 用户场景）**：

```bash
cd ../openclaw-claworks-extension
pnpm test extensions/claworks/canonical-surface.contract.test.ts
```

---

## 5. P2 生产交付（2026-05-25 批次）

| #   | 检查项                   | 命令 / 证据                                                                                           | 状态         |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------ |
| 1   | OTEL 桥接                | EventKernel → `diagnostics-otel` span（`b1c5d69d55`）                                                 | ✅           |
| 2   | OT dry-run + 生产        | `pnpm claworks:ot-dry-run` + `ot-production.claworks.fragment.json`                                   | ✅           |
| 3   | OT 实机 runbook          | [`docs/claworks/ot-live.md`](claworks/ot-live.md) + `pnpm claworks:ot-live-checklist`                 | ✅           |
| 4   | GitHub branch protection | [`docs/GITHUB-BRANCH-PROTECTION.md`](GITHUB-BRANCH-PROTECTION.md) + `pnpm claworks:branch-protection` | ✅ 文档/脚本 |
| 5   | npm publish 预检         | `pnpm claworks:npm-publish-checklist --verify`                                                        | ✅ 脚本      |
| 6   | Feishu live E2E          | gate 单测 CI + [`docs/claworks/feishu-live-e2e.md`](claworks/feishu-live-e2e.md)                      | ✅ 文档/gate |
| 7   | Studio React 编辑器      | —                                                                                                     | ⏭ 跳过      |

### P2 仍须人工

| 项                       | 阻塞原因                                         |
| ------------------------ | ------------------------------------------------ |
| GitHub branch protection | repo **admin** 执行 `--apply` 或 Settings UI     |
| npm 公开发布             | `@claworks` org + publish token + 商业许可证签收 |
| Feishu 完整回环          | 飞书凭证 + 公网 webhook + feishu 渠道配置        |
| OT 实机签收              | 现场 MQTT/OPC UA/Modbus 硬件与网络               |

---

## 6. 已知非阻塞项（后续版本）

| 项                        | 说明                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| 全仓 core type-aware lint | `pnpm lint:core`（无 `--` 收窄）仍有 ~800+ 历史 typescript/\* 告警；runtime 包已清 |
| npm 公开发布              | dry-run 就绪；见 [`docs/claworks/npm-publish.md`](claworks/npm-publish.md)         |
| Studio React 编辑器       | 静态 `/studio` 已有；全功能编辑器未做                                              |
| Extension 物理裁剪        | 138→核心扩展；非阻塞                                                               |
| Drizzle 全量 ORM          | 见 `docs/design/POSTGRES-MIGRATION-PATH.md`                                        |

---

## 7. 签收签字模板

```
交付版本：claworks v________ / commit ________________
验收日期：________________
执行人：__________________

P0 检查项 1–10：通过 ☐  未通过 ☐
备注：

客户签字：________________
```
