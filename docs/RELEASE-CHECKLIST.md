# ClaWorks Release Checklist

**用途**：客户交付 / 生产签收前的验收清单。  
**更新**：2026-05-24  
**相关文档**：[`OPERATOR-CHECKLIST.md`](OPERATOR-CHECKLIST.md)、[`DEPLOYMENT.md`](../DEPLOYMENT.md)、[`PRODUCTION-READINESS.md`](design/PRODUCTION-READINESS.md)、[`QUICKSTART.md`](../QUICKSTART.md)

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

---

## 2. P0 签收前检查（必须通过）

| #   | 检查项            | 命令 / 证据                                                               | 状态 |
| --- | ----------------- | ------------------------------------------------------------------------- | ---- |
| 1   | Runtime 单元测试  | `pnpm claworks:runtime:test` → 全绿                                       | ☐    |
| 2   | 产品烟测          | `pnpm claworks:smoke` → 全绿                                              | ☐    |
| 3   | Robot 插件契约    | `pnpm test extensions/claworks-robot` → 17/17                             | ☐    |
| 4   | Runtime lint/类型 | `pnpm lint:core -- packages/claworks-runtime` → 0 error                   | ☐    |
| 5   | Doctor 可运行     | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor` → 无 `ERR_MODULE_NOT_FOUND` | ☐    |
| 6   | 生产 Compose 有效 | `docker compose -f docker-compose.prod.yml config`                        | ☐    |
| 7   | 健康端点          | `curl -s http://127.0.0.1:18800/v1/health` → `"status":"ok"`              | ☐    |
| 8   | 生产模式          | `claworks.json` 中 `production_mode: true` 或 `CLAWORKS_PRODUCTION=1`     | ☐    |
| 9   | Gateway 令牌      | `OPENCLAW_GATEWAY_TOKEN` 已设置（非文档占位符）                           | ☐    |
| 10  | Release 干净      | `git status` 无未提交阻塞项；已打 tag                                     | ☐    |

---

## 3. P1 强烈建议（生产加固）

| #   | 检查项         | 说明                                                       | 状态 |
| --- | -------------- | ---------------------------------------------------------- | ---- |
| 1   | PostgreSQL     | `DATABASE_URL=postgresql://...` + `pnpm claworks:migrate`  | ☐    |
| 2   | OT 连接器实机  | 关闭 `simulate`；mqtt/opcua/modbus 现场联调报告            | ☐    |
| 3   | 依赖 audit     | `pnpm audit --registry=https://registry.npmjs.org` 或 SBOM | ☐    |
| 4   | Extension 裁剪 | `pnpm claworks:prune-extensions:apply`（生产白名单）       | ☐    |
| 5   | 备份策略       | `ecosystem-backup.sh` + `claworks-data` 卷定期备份         | ☐    |
| 6   | 监控           | Prometheus scrape `/v1/metrics`；OTEL 可选                 | ☐    |
| 7   | CI 绿          | `.github/workflows/claworks-smoke.yml` 在 release 分支通过 | ☐    |
| 8   | Gateway E2E    | `pnpm claworks:gateway:e2e`（本地/预发布；CI 见下方说明）  | ☐    |

### Gateway E2E 与 CI

- **脚本**：`pnpm claworks:gateway:e2e`（`scripts/claworks-gateway-e2e.mjs`）会启动真实 Gateway 并探测 `/v1` 与 MCP。
- **当前 CI**：`.github/workflows/claworks-smoke.yml` 仅跑 `pnpm claworks:smoke`（无 live gateway）；release 分支签收前请在 Testbox/本机补跑 gateway e2e。
- **后续（P2+）**：若需进 CI，建议在 `claworks-smoke` 增加 optional job（`workflow_dispatch` 或 nightly），避免 PR 默认路径每次起 Gateway。

---

## 4. 标准验收命令（复制执行）

```bash
cd claworks

# 构建 runtime dist（doctor / 运行时 import 依赖）
pnpm claworks:runtime:build

# 质量门
pnpm lint:core -- packages/claworks-runtime
pnpm claworks:runtime:test
pnpm test extensions/claworks-robot
pnpm claworks:smoke

# 可选：真实 Gateway 闭环（预发布 / 签收前手工跑；约 2–5 分钟）
# CLAWORKS_PRODUCT=1 pnpm claworks:gateway:e2e

# 产品诊断
CLAWORKS_INIT_SECURE=1 pnpm claworks:init   # 首次
CLAWORKS_PRODUCT=1 node claworks.mjs doctor

# 部署语法
docker compose -f docker-compose.prod.yml config

# 运行中健康（需 gateway 已启动）
curl -s http://127.0.0.1:18800/v1/health | head
curl -s http://127.0.0.1:18800/v1/doctor -X POST | head
```

**扩展仓（OpenClaw 用户场景）**：

```bash
cd ../openclaw-claworks-extension
pnpm test extensions/claworks/canonical-surface.contract.test.ts
```

---

## 5. 已知非阻塞项（P2 / 后续版本）

| 项                  | 说明                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| npm 公开发布        | `@claworks/runtime` 暂缓公开发布；见 `docs/design/REBRAND-TO-CLAWORKS.md` |
| Studio React 编辑器 | 静态 `/studio` 已有；全功能编辑器未做                                     |
| Extension 物理裁剪  | 138→核心扩展；非阻塞                                                      |
| Drizzle 全量 ORM    | 见 `docs/design/POSTGRES-MIGRATION-PATH.md`                               |

---

## 6. 签收签字模板

```
交付版本：claworks v________ / commit ________________
验收日期：________________
执行人：__________________

P0 检查项 1–10：通过 ☐  未通过 ☐
备注：

客户签字：________________
```
