# OpenClaw 上游同步策略

## 仓库关系

```
upstream: https://github.com/openclaw/openclaw.git   (官方，只读)
origin:   <claworks 产品仓库>                         (ClaWorks 发布)
```

**禁止**将本地 `/Users/power/Projects/openclaw`（含 Maibot / mai 定制）作为 claworks 的 upstream。  
ClaWorks 的 OpenClaw 核心必须以 **官方 GitHub** 为准。

## 基线说明（2026-05-20）

当前 `src/**` 核心已与 merge-base `402b0df3b6` 对齐，并**剔除**以下本地 fork 提交：

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

## 低冲突的关键：不改名内部标识符

以下标识符**永远不改**，确保 `git merge upstream/main` 基本无冲突：

```
src/gateway/**          不改（除 ClaWorks 产品路径见下）
src/plugins/**          不改
src/agents/**           不改
src/config/**           不改（除 paths.ts 产品模式）
OpenClawConfig          不改
definePluginEntry()     不改
openclaw.plugin.json    不改
api.runtime.*           不改
```

## ClaWorks 允许的 core 最小差异

| 文件                                          | 变更                                                              | 原因                                                |
| --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `package.json`                                | `bin.claworks`、脚本、workspace 依赖                              | 产品入口                                            |
| `src/entry.ts`                                | `detectAndApplyClaworksCli()` + runtime `product-env` 相对 import | CLI bootstrap（须保持相对路径，见 bootstrap guard） |
| `src/config/paths.ts`                         | `CLAWORKS_PRODUCT` → `~/.claworks` / `claworks.json`              | 与 OpenClaw 并存                                    |
| `src/cli/program/command-registry-core.ts`    | `packs` → `@claworks/runtime`                                     | Pack CLI                                            |
| `src/cli/program/core-command-descriptors.ts` | `packs` 命令描述                                                  | 产品 CLI                                            |

**禁止**在 `src/**` 再引入 Maibot / 本地 openclaw 定制（`projectId`、`maibotWorkspaceIndexing`、`.maibot/` 等）。

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
#         src/entry.ts、src/config/paths.ts 保留上表 ClaWorks 差异

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
```

## 建议同步频率

- **重大版本**（OpenClaw x.0）：立即同步，重点检查 gateway/plugin API
- **月度 beta**：每月一次
- **安全补丁**：按需优先
