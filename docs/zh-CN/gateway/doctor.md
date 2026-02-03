---
read_when:
  - 添加或修改 doctor 迁移
  - 引入破坏性配置变更
summary: Doctor 命令：健康检查、配置迁移和修复步骤
title: Doctor
x-i18n:
  generated_at: "2026-02-01T20:26:33Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: df7b25f60fd08d508f4c6abfc8e7e06f29bd4bbb34c3320397f47eb72c8de83f
  source_path: gateway/doctor.md
  workflow: 14
---

# Doctor

`openclaw doctor` 是 OpenClaw 的修复 + 迁移工具。它修复过时的配置/状态、检查健康状况，并提供可操作的修复步骤。

## 快速开始

```bash
openclaw doctor
```

### 无界面 / 自动化

```bash
openclaw doctor --yes
```

无需提示即接受默认值（包括适用时的重启/服务/沙箱修复步骤）。

```bash
openclaw doctor --repair
```

无需提示即应用推荐修复（安全情况下执行修复 + 重启）。

```bash
openclaw doctor --repair --force
```

同时应用激进修复（覆盖自定义 supervisor 配置）。

```bash
openclaw doctor --non-interactive
```

无提示运行，仅应用安全迁移（配置规范化 + 磁盘状态迁移）。跳过需要人工确认的重启/服务/沙箱操作。
检测到遗留状态迁移时会自动运行。

```bash
openclaw doctor --deep
```

扫描系统服务以查找额外的 Gateway网关安装（launchd/systemd/schtasks）。

如果你想在写入前查看更改，请先打开配置文件：

```bash
cat ~/.openclaw/openclaw.json
```

## 功能概述

- 可选的 git 安装预检更新（仅交互模式）。
- UI 协议新鲜度检查（当协议 schema 更新时重建控制 UI）。
- 健康检查 + 重启提示。
- Skills 状态摘要（可用/缺失/受阻）。
- 遗留值的配置规范化。
- OpenCode Zen 提供商覆盖警告（`models.providers.opencode`）。
- 遗留磁盘状态迁移（会话/智能体目录/WhatsApp 认证）。
- 状态完整性和权限检查（会话、转录、状态目录）。
- 本地运行时的配置文件权限检查（chmod 600）。
- 模型认证健康：检查 OAuth 过期、可刷新即将过期的令牌、报告认证配置的冷却/禁用状态。
- 额外工作区目录检测（`~/openclaw`）。
- 启用沙箱时的沙箱镜像修复。
- 遗留服务迁移和额外 Gateway网关检测。
- Gateway网关运行时检查（服务已安装但未运行；缓存的 launchd 标签）。
- 渠道状态警告（从运行中的 Gateway网关探测）。
- Supervisor 配置审计（launchd/systemd/schtasks）及可选修复。
- Gateway网关运行时最佳实践检查（Node vs Bun、版本管理器路径）。
- Gateway网关端口冲突诊断（默认 `18789`）。
- 开放 私信 策略的安全警告。
- 未设置 `gateway.auth.token` 时的 Gateway网关认证警告（本地模式；提供令牌生成）。
- Linux 上的 systemd linger 检查。
- 源码安装检查（pnpm workspace 不匹配、缺失 UI 资源、缺失 tsx 二进制文件）。
- 写入更新后的配置 + 向导元数据。

## 详细行为和原理

### 0) 可选更新（git 安装）

如果这是一个 git 检出且 doctor 在交互模式下运行，它会在运行 doctor 之前提供更新（fetch/rebase/build）。

### 1) 配置规范化

如果配置包含遗留值格式（例如 `messages.ackReaction` 没有渠道特定的覆盖），doctor 会将其规范化为当前 schema。

### 2) 遗留配置键迁移

当配置包含已弃用的键时，其他命令会拒绝运行并要求你运行 `openclaw doctor`。

Doctor 将：

- 说明找到了哪些遗留键。
- 显示它应用的迁移。
- 使用更新后的 schema 重写 `~/.openclaw/openclaw.json`。

Gateway网关在启动时检测到遗留配置格式时也会自动运行 doctor 迁移，因此过时的配置无需手动干预即可修复。

当前迁移：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → 顶级 `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen 提供商覆盖

如果你手动添加了 `models.providers.opencode`（或 `opencode-zen`），它会覆盖 `@mariozechner/pi-ai` 内置的 OpenCode Zen 目录。这可能会将所有模型强制指向单个 API 或将成本归零。Doctor 会发出警告，以便你移除覆盖并恢复按模型的 API 路由 + 成本。

### 3) 遗留状态迁移（磁盘布局）

Doctor 可以将旧版磁盘布局迁移到当前结构：

- 会话存储 + 转录：
  - 从 `~/.openclaw/sessions/` 到 `~/.openclaw/agents/<agentId>/sessions/`
- 智能体目录：
  - 从 `~/.openclaw/agent/` 到 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 认证状态（Baileys）：
  - 从遗留的 `~/.openclaw/credentials/*.json`（`oauth.json` 除外）
  - 到 `~/.openclaw/credentials/whatsapp/<accountId>/...`（默认账户 ID：`default`）

这些迁移尽力执行且幂等；当 doctor 保留任何遗留文件夹作为备份时会发出警告。Gateway网关/CLI 在启动时也会自动迁移遗留会话 + 智能体目录，使历史/认证/模型落入每个智能体的路径中，无需手动运行 doctor。WhatsApp 认证仅通过 `openclaw doctor` 进行迁移。

### 4) 状态完整性检查（会话持久化、路由和安全性）

状态目录是运行的核心枢纽。如果它消失，你将丢失会话、凭据、日志和配置（除非你在其他地方有备份）。

Doctor 检查：

- **状态目录缺失**：警告灾难性状态丢失，提示重新创建目录，并提醒无法恢复丢失的数据。
- **状态目录权限**：验证可写性；提供修复权限的选项（检测到所有者/组不匹配时发出 `chown` 提示）。
- **会话目录缺失**：`sessions/` 和会话存储目录是持久化历史记录和避免 `ENOENT` 崩溃所必需的。
- **转录不匹配**：当近期会话条目缺少转录文件时发出警告。
- **主会话"单行 JSONL"**：当主转录只有一行时标记（历史记录未在累积）。
- **多个状态目录**：当多个 `~/.openclaw` 文件夹存在于不同的 home 目录中，或 `OPENCLAW_STATE_DIR` 指向其他位置时发出警告（历史记录可能在不同安装间分裂）。
- **远程模式提醒**：如果 `gateway.mode=remote`，doctor 提醒你在远程主机上运行（状态存储在那里）。
- **配置文件权限**：当 `~/.openclaw/openclaw.json` 对组/其他用户可读时发出警告，并提供收紧为 `600` 的选项。

### 5) 模型认证健康（OAuth 过期）

Doctor 检查认证存储中的 OAuth 配置，当令牌即将过期/已过期时发出警告，并在安全时刷新它们。如果 Anthropic Claude Code 配置过时，它会建议运行 `claude setup-token`（或粘贴 setup-token）。刷新提示仅在交互运行（TTY）时出现；`--non-interactive` 跳过刷新尝试。

Doctor 还会报告由于以下原因暂时不可用的认证配置：

- 短期冷却（速率限制/超时/认证失败）
- 较长时间的禁用（账单/额度失败）

### 6) Hooks 模型验证

如果设置了 `hooks.gmail.model`，doctor 会根据目录和允许列表验证模型引用，并在无法解析或被禁止时发出警告。

### 7) 沙箱镜像修复

当启用沙箱时，doctor 检查 Docker 镜像，并在当前镜像缺失时提供构建或切换到遗留名称的选项。

### 8) Gateway网关服务迁移和清理提示

Doctor 检测遗留 Gateway网关服务（launchd/systemd/schtasks），并提供删除它们并使用当前 Gateway网关端口安装 OpenClaw 服务的选项。它还可以扫描额外的类 Gateway网关服务并打印清理提示。以配置文件命名的 OpenClaw Gateway网关服务被视为一等公民，不会被标记为"额外"。

### 9) 安全警告

当提供商对 私信 开放且没有允许列表时，或当策略以危险方式配置时，doctor 会发出警告。

### 10) systemd linger（Linux）

如果作为 systemd 用户服务运行，doctor 确保 linger 已启用，以便 Gateway网关在注销后保持运行。

### 11) Skills 状态

Doctor 打印当前工作区可用/缺失/受阻 Skills 的快速摘要。

### 12) Gateway网关认证检查（本地令牌）

当本地 Gateway网关缺少 `gateway.auth` 时，doctor 发出警告并提供生成令牌的选项。使用 `openclaw doctor --generate-gateway-token` 在自动化中强制创建令牌。

### 13) Gateway网关健康检查 + 重启

Doctor 运行健康检查，并在 Gateway网关看起来不健康时提供重启选项。

### 14) 渠道状态警告

如果 Gateway网关健康，doctor 运行渠道状态探测并报告警告及建议的修复方案。

### 15) Supervisor 配置审计 + 修复

Doctor 检查已安装的 supervisor 配置（launchd/systemd/schtasks）是否有缺失或过时的默认值（例如 systemd 的 network-online 依赖和重启延迟）。当发现不匹配时，它会推荐更新并可以将服务文件/任务重写为当前默认值。

说明：

- `openclaw doctor` 在重写 supervisor 配置前会提示确认。
- `openclaw doctor --yes` 接受默认修复提示。
- `openclaw doctor --repair` 无需提示即应用推荐修复。
- `openclaw doctor --repair --force` 覆盖自定义 supervisor 配置。
- 你始终可以通过 `openclaw gateway install --force` 强制完全重写。

### 16) Gateway网关运行时 + 端口诊断

Doctor 检查服务运行时（PID、上次退出状态），并在服务已安装但实际未运行时发出警告。它还检查 Gateway网关端口（默认 `18789`）上的端口冲突并报告可能的原因（Gateway网关已在运行、SSH 隧道）。

### 17) Gateway网关运行时最佳实践

当 Gateway网关服务运行在 Bun 或版本管理器管理的 Node 路径（`nvm`、`fnm`、`volta`、`asdf` 等）上时，doctor 会发出警告。WhatsApp + Telegram 渠道需要 Node，而版本管理器路径在升级后可能会失效，因为服务不会加载你的 shell 初始化文件。Doctor 会在系统 Node 安装可用时提供迁移选项（Homebrew/apt/choco）。

### 18) 配置写入 + 向导元数据

Doctor 持久化所有配置更改，并记录向导元数据以标记 doctor 运行。

### 19) 工作区提示（备份 + 记忆系统）

当缺少工作区记忆系统时，doctor 会建议添加，并在工作区尚未纳入 git 管理时打印备份提示。

参见 [/concepts/agent-workspace](/concepts/agent-workspace) 获取工作区结构和 git 备份的完整指南（推荐使用私有 GitHub 或 GitLab）。
