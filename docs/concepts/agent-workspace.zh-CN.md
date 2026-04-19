---
summary: "代理工作区：位置、布局和备份策略"
read_when:
  - 你需要解释代理工作区或其文件布局
  - 你想备份或迁移代理工作区
---

# 代理工作区

工作区是代理的家。它是用于文件工具和工作区上下文的唯一工作目录。保持它的私密性并将其视为内存。

这与 `~/.openclaw/` 分开，后者存储配置、凭证和会话。

**重要：** 工作区是**默认工作目录**，不是硬沙盒。工具根据工作区解析相对路径，但除非启用沙盒，否则绝对路径仍然可以到达主机上的其他地方。如果你需要隔离，请使用 [`agents.defaults.sandbox`](/gateway/sandboxing)（和/或每个代理的沙盒配置）。当启用沙盒且 `workspaceAccess` 不是 `"rw"` 时，工具在 `~/.openclaw/sandboxes` 下的沙盒工作区内操作，而不是你的主机工作区。

## 默认位置

- 默认：`~/.openclaw/workspace`
- 如果设置了 `OPENCLAW_PROFILE` 且不是 `"default"`，默认变为 `~/.openclaw/workspace-<profile>`。
- 在 `~/.openclaw/openclaw.json` 中覆盖：

```json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
    },
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 将创建工作区并在引导文件缺失时播种它们。
沙盒种子副本仅接受常规工作区文件；解析到源工作区外的符号链接/硬链接别名被忽略。

如果你已经自己管理工作区文件，你可以禁用引导文件创建：

```json5
{
  agents: {
    defaults: {
      skipBootstrap: true,
    },
  },
}
```

## 额外的工作区文件夹

较旧的安装可能已创建 `~/openclaw`。保留多个工作区目录可能会导致混乱的身份验证或状态漂移，因为一次只有一个工作区处于活动状态。

**建议：** 保持单个活动工作区。如果你不再使用额外的文件夹，将它们归档或移至回收站（例如 `trash ~/openclaw`）。如果你有意保留多个工作区，请确保 `agents.defaults.workspace` 指向活动的那个。

当 `openclaw doctor` 检测到额外的工作区目录时会发出警告。

## 工作区文件映射（每个文件的含义）

这些是 OpenClaw 期望在工作区内的标准文件：

- `AGENTS.md`
  - 代理的操作说明以及它应如何使用内存。
  - 在每个会话开始时加载。
  - 放置规则、优先级和"如何行为"细节的好地方。

- `SOUL.md`
  - 角色、语调和边界。
  - 每个会话加载。
  - 指南：[SOUL.md 个性指南](/concepts/soul)

- `USER.md`
  - 用户是谁以及如何称呼他们。
  - 每个会话加载。

- `IDENTITY.md`
  - 代理的名称、氛围和表情符号。
  - 在引导仪式期间创建/更新。

- `TOOLS.md`
  - 关于你本地工具和约定的笔记。
  - 不控制工具可用性；它只是指导。

- `HEARTBEAT.md`
  - 心跳运行的可选小清单。
  - 保持简短以避免令牌消耗。

- `BOOT.md`
  - 启用内部钩子时在网关重启时执行的可选启动清单。
  - 保持简短；使用消息工具进行出站发送。

- `BOOTSTRAP.md`
  - 一次性首次运行仪式。
  - 仅为全新工作区创建。
  - 仪式完成后删除它。

- `memory/YYYY-MM-DD.md`
  - 每日内存日志（每天一个文件）。
  - 建议在会话开始时阅读今天 + 昨天。

- `MEMORY.md`（可选）
  - 精心策划的长期记忆。
  - 仅在主私有会话中加载（不在共享/群组上下文中）。

有关工作流和自动内存刷新，请参阅 [内存](/concepts/memory)。

- `skills/`（可选）
  - 工作区特定技能。
  - 该工作区的最高优先级技能位置。
  - 当名称冲突时，覆盖项目代理技能、个人代理技能、管理技能、捆绑技能和 `skills.load.extraDirs`。

- `canvas/`（可选）
  - 节点显示的 Canvas UI 文件（例如 `canvas/index.html`）。

如果任何引导文件缺失，OpenClaw 会将会话中注入"缺失文件"标记并继续。大的引导文件在注入时会被截断；使用 `agents.defaults.bootstrapMaxChars`（默认：12000）和 `agents.defaults.bootstrapTotalMaxChars`（默认：60000）调整限制。`openclaw setup` 可以重新创建缺失的默认值而不覆盖现有文件。

## 工作区中没有的内容

这些位于 `~/.openclaw/` 下，**不应**提交到工作区仓库：

- `~/.openclaw/openclaw.json`（配置）
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（模型身份验证配置文件：OAuth + API 密钥）
- `~/.openclaw/credentials/`（通道/提供者状态加上遗留 OAuth 导入数据）
- `~/.openclaw/agents/<agentId>/sessions/`（会话记录 + 元数据）
- `~/.openclaw/skills/`（管理技能）

如果你需要迁移会话或配置，请单独复制它们并将它们排除在版本控制之外。

## Git 备份（推荐，私有）

将工作区视为私有内存。将其放在**私有** git 仓库中，以便备份和可恢复。

在运行网关的机器上运行这些步骤（工作区所在的位置）。

### 1) 初始化仓库

如果安装了 git，全新的工作区会自动初始化。如果此工作区尚未成为仓库，请运行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 添加私有远程（对初学者友好的选项）

选项 A：GitHub web UI

1. 在 GitHub 上创建一个新的**私有**仓库。
2. 不要使用 README 初始化（避免合并冲突）。
3. 复制 HTTPS 远程 URL。
4. 添加远程并推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

选项 B：GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

选项 C：GitLab web UI

1. 在 GitLab 上创建一个新的**私有**仓库。
2. 不要使用 README 初始化（避免合并冲突）。
3. 复制 HTTPS 远程 URL。
4. 添加远程并推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) 持续更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 不要提交机密

即使在私有仓库中，也避免在工作区中存储机密：

- API 密钥、OAuth 令牌、密码或私人凭证。
- `~/.openclaw/` 下的任何内容。
- 聊天或敏感附件的原始转储。

如果你必须存储敏感引用，请使用占位符并将真实机密保存在其他地方（密码管理器、环境变量或 `~/.openclaw/`）。

建议的 `.gitignore` 启动器：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 将工作区移动到新机器

1. 将仓库克隆到所需路径（默认 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中设置 `agents.defaults.workspace` 到该路径。
3. 运行 `openclaw setup --workspace <path>` 以播种任何缺失的文件。
4. 如果你需要会话，请从旧机器单独复制 `~/.openclaw/agents/<agentId>/sessions/`。

## 高级注释

- 多代理路由可以为每个代理使用不同的工作区。有关路由配置，请参阅 [通道路由](/channels/channel-routing)。
- 如果启用了 `agents.defaults.sandbox`，非主会话可以使用 `agents.defaults.sandbox.workspaceRoot` 下的每个会话沙盒工作区。

## 相关

- [常规指令](/automation/standing-orders) — 工作区文件中的持久指令
- [心跳](/gateway/heartbeat) — HEARTBEAT.md 工作区文件
- [会话](/concepts/session) — 会话存储路径
- [沙盒](/gateway/sandboxing) — 沙盒环境中的工作区访问
