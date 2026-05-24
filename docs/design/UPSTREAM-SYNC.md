# OpenClaw 上游同步策略

## 仓库关系

```
upstream: https://github.com/openclaw/openclaw.git   (官方，只读)
origin:   <claworks 产品仓库>                         (ClaWorks 发布)
```

**禁止**将本地 sibling `../openclaw/` 作为 claworks 的 upstream 或 merge 源。

| 路径                           | 角色                                  | 同步策略                                  |
| ------------------------------ | ------------------------------------- | ----------------------------------------- |
| `github.com/openclaw/openclaw` | **唯一 upstream**                     | `git fetch upstream` → rebase/merge       |
| `../openclaw/`（本地 sibling） | **Maibot fork**（`local/mai-wip` 等） | 只读对照；**勿 merge 进 claworks**        |
| `claworks/`（本仓）            | ClaWorks 产品 fork                    | 从官方 upstream 同步 core；产品层独立维护 |

Maibot 定制（`projectId`、`maibotWorkspaceIndexing`、`.maibot/`、飞书本地 seam 等）属于 sibling openclaw，**不得**通过 upstream 同步进入 claworks。

## Sibling 依赖（非 upstream）

产品与发布依赖以下 sibling 仓，通过 HTTP / npm / 挂载交互，**不**作为 git upstream：

| Sibling 仓                                                           | 用途                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`../claworks-packs/`](../claworks-packs/)                           | Pack YAML/TS **唯一真源**；`CLAWORKS_PACKS_DIR` / Nexus catalog |
| [`../openclaw-claworks-extension/`](../openclaw-claworks-extension/) | 官方 OpenClaw 用户连接 ClaWorks Gateway 的桥接插件              |
| `../daily-report-system/`                                            | 日报垂直应用（可选）                                            |

详见 [`ECOSYSTEM-LAYOUT.md`](ECOSYSTEM-LAYOUT.md)、[`LOCAL-GIT.md`](../LOCAL-GIT.md)。

## 基线说明（2026-05-20）

**已同步**：`upstream/main` @ `2026.5.19`（merge commit `af9da9014b`，2026-05-20）。

此前 fork 中以下本地 mai 提交已剔除，不再作为基线：

| 提交         | 说明                                                              | 处理   |
| ------------ | ----------------------------------------------------------------- | ------ |
| `d9bedb8e0c` | Maibot gateway（projectId、extraSystemPrompt、indexing snapshot） | 已回退 |
| `21d3d94ded` | mai 本地 wiki/memory-wiki 恢复 + 半截 doctor import               | 已回退 |

ClaWorks **独有**层（不与 upstream 合并冲突）：

```
packages/claworks-runtime/     @claworks/runtime（EventKernel / planes / interfaces）
packages/claworks-sdk/         Pack 作者 SDK
extensions/claworks-robot/     OpenClaw 薄插件（唯一 api.* 胶水）
claworks.mjs                   独立 CLI 入口（~/.claworks 隔离）
scripts/claworks-*.mjs         验证与 init
docs/design/                   产品设计文档
contrib/claworks-*             产品配置片段
```

## 低冲突原则：不改名 upstream 内部标识符

以下标识符**永远不改**，确保 `git merge upstream/main` 基本无冲突：

```
src/gateway/**          不改（除 ClaWorks 产品路径见下）
src/plugins/**          不改
src/agents/**           不改
OpenClawConfig          不改
definePluginEntry()     不改
openclaw.plugin.json    不改
api.runtime.*           不改
```

## Core 产品 seam 清单（`src/` 内，2026-05-24 审计）

全链路审计发现 **40+ 文件**含 ClaWorks 产品钩子（非文档曾称的「~5 个 seam」）。按职责分类如下；合并 upstream 时 **保留 ClaWorks 侧**，其余随 upstream 更新。

### A. 启动与配置（必保留）

| 文件                                   | 变更                                                              | 原因                                                |
| -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `package.json`                         | `bin.claworks`、脚本、workspace 依赖                              | 产品入口                                            |
| `src/entry.ts`                         | `detectAndApplyClaworksCli()` + runtime `product-env` 相对 import | CLI bootstrap（须保持相对路径，见 bootstrap guard） |
| `src/config/paths.ts`                  | `CLAWORKS_PRODUCT` → `~/.claworks` / `claworks.json`              | 与 OpenClaw 并存                                    |
| `src/config/claworks-gateway.ts`       | 端口 18800 / 18789 冲突检测                                       | 产品隔离                                            |
| `src/config/claworks-product-env.ts`   | 产品 env 解析                                                     | 配置真源                                            |
| `src/config/claworks-product-guard.ts` | 保留端口 / 配置守卫                                               | 防误用 OpenClaw 端口                                |

### B. CLI 与命令面

| 文件                                          | 说明                                    |
| --------------------------------------------- | --------------------------------------- |
| `src/cli/cli-name.ts`                         | `claworks` vs `openclaw` CLI 名         |
| `src/cli/command-format.ts`                   | help / 示例命令产品化                   |
| `src/cli/product-surface.ts`                  | 产品 CLI 元数据（端口、状态路径）       |
| `src/cli/run-main.ts`                         | 产品 gateway 提示                       |
| `src/cli/program/command-registry-core.ts`    | `packs` → `@claworks/runtime`           |
| `src/cli/program/core-command-descriptors.ts` | `packs` 命令描述                        |
| `src/cli/program/register.subclis-core.ts`    | claworks 子 CLI 注册                    |
| `src/cli/update-cli/update-command.ts`        | update 后 repair 指引                   |
| `src/cli/product/claworks-bootstrap.ts`       | `claworks start` bootstrap              |
| `src/cli/product/doctor-health-claworks.ts`   | 产品 doctor 健康项                      |
| `src/cli/product/register-claworks-*.ts`      | init / start / packs / evolution 子命令 |

### C. 用户可见文案与向导

| 文件                                       | 说明                                |
| ------------------------------------------ | ----------------------------------- |
| `src/wizard/setup.ts`                      | 向导入口产品化                      |
| `src/wizard/setup.claworks-defaults.ts`    | 默认端口 / 路径                     |
| `src/wizard/product-copy.ts`               | 文案替换（openclaw → claworks）     |
| `src/wizard/i18n/index.ts`                 | i18n 产品化层                       |
| `src/commands/configure.wizard.ts`         | configure 向导                      |
| `src/commands/configure.channels.ts`       | channels 提示                       |
| `src/commands/doctor-lint.ts`              | doctor lint 输出产品化              |
| `src/auto-reply/reply/abort-primitives.ts` | IM abort 触发词（含 claworks 变体） |

### D. Daemon / 服务安装

| 文件                                         | 说明                                    |
| -------------------------------------------- | --------------------------------------- |
| `src/daemon/constants.ts`                    | LaunchAgent label `ai.claworks.gateway` |
| `src/daemon/claworks-launch-agent-repair.ts` | 端口 18800 隔离 repair                  |

### E. Doctor / 健康检查

| 文件                                          | 说明                 |
| --------------------------------------------- | -------------------- |
| `src/flows/claworks-product-health-checks.ts` | 产品 health checks   |
| `src/flows/doctor-health-contributions.ts`    | 注册 ClaWorks 贡献项 |

### F. Gateway / UI 契约

| 文件                                 | 说明              |
| ------------------------------------ | ----------------- |
| `src/gateway/control-ui-contract.ts` | Control UI 产品面 |

### G. 测试（随对应模块保留）

`src/**/*.claworks*.test.ts`、`src/cli/product-surface.test.ts` 等 — 合并时保留 ClaWorks 断言。

**不在 `src/` 的产品代码**（upstream 合并通常零冲突）：

```
packages/claworks-runtime/**
extensions/claworks-robot/**
contrib/**
connectors/**
scripts/claworks-*
```

**禁止**在 `src/**` 再引入 Maibot / sibling openclaw 定制。

## 架构迁移（runtime 包）

根目录 **不再有** `src/kernel`、`src/planes`、`src/interfaces`、`src/claworks` shim。  
运行时仅在 `packages/claworks-runtime/src/`。详见 `RUNTIME-PACKAGE.md`。

`entry.ts` 通过相对路径引用 bootstrap 模块（满足 `check-cli-bootstrap-imports`）：

```typescript
import { detectAndApplyClaworksCli } from "../packages/claworks-runtime/src/claworks/product-env.js";
```

## 同步步骤

```bash
git fetch upstream

# 预览差异（避免把 Maibot 定制带回来）
git log --oneline HEAD..upstream/main -20
git diff HEAD upstream/main --stat

git merge upstream/main
# 冲突时：package.json 保留 claworks bin/name；README/docs/design 保留 ClaWorks；
#         src/entry.ts、src/config/paths.ts、上表 A 类文件保留 ClaWorks 差异

pnpm install
pnpm build
pnpm claworks:smoke
pnpm test:changed
```

## 同步后自检

```bash
# 不应出现 Maibot 残留
rg -i maibot src/ contrib/ || echo "clean"

# bootstrap 仍通过
node scripts/check-cli-bootstrap-imports.mjs

# 产品 seam 未被 upstream 覆盖（抽样）
rg -l 'isClaworksProduct|CLAWORKS_PRODUCT' src/config/paths.ts src/entry.ts
```

## 建议同步频率

- **重大版本**（OpenClaw x.0）：立即同步，重点检查 gateway/plugin API
- **月度 beta**：每月一次
- **安全补丁**：按需优先
