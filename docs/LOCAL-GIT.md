# ClaWorks 本地 Git 工作流

> 本仓 fork 自 OpenClaw upstream；ClaWorks 产品提交在本地分支维护。

## Remotes

| Remote           | 用途                                                       |
| ---------------- | ---------------------------------------------------------- |
| `upstream`       | `https://github.com/openclaw/openclaw.git` — 同步 OpenClaw |
| （可选）`origin` | 你的 ClaWorks fork — `git remote add origin …` 后 push     |

## 推荐分支

```bash
# 本地产品开发（当前整理与 ClaWorks 功能）
git checkout local/claworks-product

# 仅同步 upstream OpenClaw（无 ClaWorks 产品层）
git checkout main
git fetch upstream
git rebase upstream/main
git checkout local/claworks-product
git rebase main
```

| 分支                     | 说明                                          |
| ------------------------ | --------------------------------------------- |
| `main`                   | 跟踪 upstream；尽量保持可 fast-forward rebase |
| `local/claworks-product` | ClaWorks 产品整理、runtime、文档、contrib     |

## 提交

```bash
./scripts/committer "type(scope): message" path/to/files...
pnpm test packages/claworks-runtime/src/claworks/product-config-repair.test.ts
```

## 忽略（仅本机）

`.git/info/exclude` 已配置 `.cursor/`、`.agent-trace/` 等，不进入仓库。

## 本地 Git 备份（不推 GitHub）

```bash
chmod +x ~/Projects/scripts/ecosystem-backup.sh
~/Projects/scripts/ecosystem-backup.sh
# 或指定目录：~/Projects/scripts/ecosystem-backup.sh ~/Backups/claworks-$(date +%Y%m%d)
```

为五仓创建 `git bundle` + 分支/HEAD 快照，并拷贝 `PROJECT-LAYOUT.md` 与 workspace 文件。

| 仓                             | 分支            | 说明                            |
| ------------------------------ | --------------- | ------------------------------- |
| `claworks-packs/`              | `main`          | Pack SSOT                       |
| `openclaw-claworks-extension/` | `main`          | 桥接插件                        |
| `daily-report-system/`         | `main`          | 日报垂直应用                    |
| `openclaw/`                    | `local/mai-wip` | upstream + 飞书/Maibot 本地定制 |

## ⚠️ Maibot sibling 警告

本地 `../openclaw/` **不是** claworks 的 upstream。它是 Maibot/飞书定制 fork（`local/mai-wip`），含 `projectId`、`maibotWorkspaceIndexing` 等与官方 OpenClaw 不同的 seam。

- **upstream 唯一真源**：`https://github.com/openclaw/openclaw.git`
- **禁止**将 sibling openclaw 的提交 merge/rebase 进 `claworks/`
- 需要对照 Maibot 行为时只读 diff；产品 seam 清单见 [`docs/design/UPSTREAM-SYNC.md`](design/UPSTREAM-SYNC.md)

五仓布局见 [`docs/design/ECOSYSTEM-LAYOUT.md`](design/ECOSYSTEM-LAYOUT.md)。
