---
read_when:
  - 你需要解释智能体工作区或其文件布局
  - 你想备份或迁移智能体工作区
summary: 智能体工作区：位置、布局和备份策略
title: 智能体工作区
x-i18n:
  generated_at: "2026-02-03T07:45:49Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 84c550fd89b5f2474aeae586795485fd29d36effbb462f13342b31540fc18b82
  source_path: concepts/agent-workspace.md
  workflow: 15
---

# 智能体工作区

工作区是智能体的家。它是文件工具和工作区上下文使用的唯一工作目录。请保持其私密性并将其视为记忆。

这与 `~/.openclaw/` 是分开的，后者存储配置、凭证和会话。

**重要：** 工作区是**默认 cwd**，而不是硬性沙箱。工具会根据工作区解析相对路径，但绝对路径仍然可以访问主机上的其他位置，除非启用了沙箱隔离。如果你需要隔离，请使用
[`agents.defaults.sandbox`](/gateway/sandboxing)（和/或每智能体沙箱配置）。
当启用沙箱隔离且 `workspaceAccess` 不是 `"rw"` 时，工具在 `~/.openclaw/sandboxes` 下的沙箱工作区内操作，而不是你的主机工作区。

## 默认位置

- 默认：`~/.openclaw/workspace`
- 如果设置了 `OPENCLAW_PROFILE` 且不是 `"default"`，默认值变为
  `~/.openclaw/workspace-<profile>`。
- 在 `~/.openclaw/openclaw.json` 中覆盖：

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 将创建工作区并在缺失时填充引导文件。

如果你已经自己管理工作区文件，可以禁用引导文件创建：

```json5
{ agent: { skipBootstrap: true } }
```

## 额外的工作区文件夹

旧版安装可能创建了 `~/openclaw`。保留多个工作区目录可能会导致混乱的认证或状态漂移，因为同一时间只有一个工作区是活动的。

**建议：** 保持单个活动工作区。如果你不再使用额外的文件夹，请归档或移至废纸篓（例如 `trash ~/openclaw`）。
如果你有意保留多个工作区，请确保 `agents.defaults.workspace` 指向活动的那个。

`openclaw doctor` 在检测到额外工作区目录时会发出警告。

## 工作区文件映射（每个文件的含义）

这些是 OpenClaw 在工作区内期望的标准文件：

- `AGENTS.md`
  - 智能体的操作指南以及它应该如何使用记忆。
  - 在每个会话开始时加载。
  - 适合放置规则、优先级和"如何行为"的详细信息。

- `SOUL.md`
  - 人设、语气和边界。
  - 每个会话加载。

- `USER.md`
  - 用户是谁以及如何称呼他们。
  - 每个会话加载。

- `IDENTITY.md`
  - 智能体的名称、风格和表情符号。
  - 在引导仪式期间创建/更新。

- `TOOLS.md`
  - 关于你本地工具和惯例的注释。
  - 不控制工具可用性；仅作为指导。

- `HEARTBEAT.md`
  - 可选的心跳运行小型检查清单。
  - 保持简短以避免 token 消耗。

- `BOOT.md`
  - 当启用内部 hooks 时，在 Gateway 网关重启时执行的可选启动检查清单。
  - 保持简短；使用 message 工具进行出站发送。

- `BOOTSTRAP.md`
  - 一次性首次运行仪式。
  - 仅为全新工作区创建。
  - 仪式完成后删除它。

- `memory/YYYY-MM-DD.md`
  - 每日记忆日志（每天一个文件）。
  - 建议在会话开始时读取今天 + 昨天的内容。

- `MEMORY.md`（可选）
  - 精选的长期记忆。
  - 仅在主私密会话中加载（不在共享/群组上下文中）。

参见 [记忆](/concepts/memory) 了解工作流程和自动记忆刷新。

- `skills/`（可选）
  - 工作区特定的 Skills。
  - 当名称冲突时覆盖托管/捆绑的 Skills。

- `canvas/`（可选）
  - 用于节点显示的 Canvas UI 文件（例如 `canvas/index.html`）。

如果任何引导文件缺失，OpenClaw 会在会话中注入"缺失文件"标记并继续。大型引导文件在注入时会被截断；使用 `agents.defaults.bootstrapMaxChars` 调整限制（默认：20000）。
`openclaw setup` 可以重新创建缺失的默认值而不覆盖现有文件。

## 工作区中不包含的内容

这些位于 `~/.openclaw/` 下，不应提交到工作区仓库：

- `~/.openclaw/openclaw.json`（配置）
- `~/.openclaw/credentials/`（OAuth token、API 密钥）
- `~/.openclaw/agents/<agentId>/sessions/`（会话记录 + 元数据）
- `~/.openclaw/skills/`（托管的 Skills）

如果你需要迁移会话或配置，请单独复制它们并将它们排除在版本控制之外。

## Git 备份（推荐，私有）

将工作区视为私密记忆。将其放入**私有** git 仓库以便备份和恢复。

在运行 Gateway 网关的机器上执行这些步骤（工作区就在那里）。

### 1）初始化仓库

如果安装了 git，全新工作区会自动初始化。如果此工作区还不是仓库，请运行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2）添加私有远程（适合初学者的选项）

选项 A：GitHub 网页界面

1. 在 GitHub 上创建新的**私有**仓库。
2. 不要用 README 初始化（避免合并冲突）。
3. 复制 HTTPS 远程 URL。
4. 添加远程并推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

选项 B：GitHub CLI（`gh`）

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

选项 C：GitLab 网页界面

1. 在 GitLab 上创建新的**私有**仓库。
2. 不要用 README 初始化（避免合并冲突）。
3. 复制 HTTPS 远程 URL。
4. 添加远程并推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3）持续更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 不要提交密钥

即使在私有仓库中，也要避免在工作区中存储密钥：

- API 密钥、OAuth token、密码或私有凭证。
- `~/.openclaw/` 下的任何内容。
- 聊天的原始转储或敏感附件。

如果你必须存储敏感引用，请使用占位符并将真正的密钥保存在其他地方（密码管理器、环境变量或 `~/.openclaw/`）。

建议的 `.gitignore` 起始配置：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 将工作区迁移到新机器

1. 将仓库克隆到所需路径（默认 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中将 `agents.defaults.workspace` 设置为该路径。
3. 运行 `openclaw setup --workspace <path>` 来填充任何缺失的文件。
4. 如果你需要会话，请单独从旧机器复制 `~/.openclaw/agents/<agentId>/sessions/`。

## 高级注意事项

- 多智能体路由可以为每个智能体使用不同的工作区。参见
  [渠道路由](/channels/channel-routing) 了解路由配置。
- 如果启用了 `agents.defaults.sandbox`，非主会话可以在 `agents.defaults.sandbox.workspaceRoot` 下使用每会话沙箱工作区。
