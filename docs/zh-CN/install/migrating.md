---
read_when:
  - 你正在将 OpenClaw 迁移到新的笔记本电脑/服务器
  - 你想保留会话、认证和渠道登录（WhatsApp 等）
summary: 将 OpenClaw 安装从一台机器迁移到另一台
title: 迁移指南
x-i18n:
  generated_at: "2026-02-03T07:49:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 604d862c4bf86e7924d09028db8cc2514ca6f1d64ebe8bb7d1e2dde57ef70caa
  source_path: install/migrating.md
  workflow: 15
---

# 将 OpenClaw 迁移到新机器

本指南将 OpenClaw Gateway 网关从一台机器迁移到另一台，**无需重新进行新手引导**。

迁移在概念上很简单：

- 复制**状态目录**（`$OPENCLAW_STATE_DIR`，默认：`~/.openclaw/`）— 这包括配置、认证、会话和渠道状态。
- 复制你的**工作区**（默认 `~/.openclaw/workspace/`）— 这包括你的智能体文件（记忆、提示等）。

但在**配置文件**、**权限**和**部分复制**方面有常见的陷阱。

## 开始之前（你要迁移什么）

### 1）确定你的状态目录

大多数安装使用默认值：

- **状态目录：** `~/.openclaw/`

但如果你使用以下方式，可能会不同：

- `--profile <name>`（通常变成 `~/.openclaw-<profile>/`）
- `OPENCLAW_STATE_DIR=/some/path`

如果你不确定，在**旧**机器上运行：

```bash
openclaw status
```

在输出中查找 `OPENCLAW_STATE_DIR` / profile 的提及。如果你运行多个 Gateway 网关，对每个配置文件重复此操作。

### 2）确定你的工作区

常见默认值：

- `~/.openclaw/workspace/`（推荐的工作区）
- 你创建的自定义文件夹

你的工作区是 `MEMORY.md`、`USER.md` 和 `memory/*.md` 等文件所在的位置。

### 3）了解你将保留什么

如果你复制**两者**——状态目录和工作区，你将保留：

- Gateway 网关配置（`openclaw.json`）
- 认证配置文件 / API 密钥 / OAuth 令牌
- 会话历史 + 智能体状态
- 渠道状态（例如 WhatsApp 登录/会话）
- 你的工作区文件（记忆、Skills 笔记等）

如果你**只**复制工作区（例如通过 Git），你**不会**保留：

- 会话
- 凭证
- 渠道登录

这些存储在 `$OPENCLAW_STATE_DIR` 下。

## 迁移步骤（推荐）

### 步骤 0 — 备份（旧机器）

在**旧**机器上，首先停止 Gateway 网关，这样文件不会在复制过程中发生变化：

```bash
openclaw gateway stop
```

（可选但推荐）归档状态目录和工作区：

```bash
# 如果你使用配置文件或自定义位置，请调整路径
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

如果你有多个配置文件/状态目录（例如 `~/.openclaw-main`、`~/.openclaw-work`），分别归档每个。

### 步骤 1 — 在新机器上安装 OpenClaw

在**新**机器上，安装 CLI（如果需要还有 Node）：

- 参见：[安装](/install)

在这个阶段，如果新手引导创建了一个新的 `~/.openclaw/` 也没关系 — 你将在下一步覆盖它。

### 步骤 2 — 将状态目录 + 工作区复制到新机器

复制**两者**：

- `$OPENCLAW_STATE_DIR`（默认 `~/.openclaw/`）
- 你的工作区（默认 `~/.openclaw/workspace/`）

常见方法：

- `scp` 压缩包并解压
- 通过 SSH 使用 `rsync -a`
- 外部驱动器

复制后，确保：

- 包含了隐藏目录（例如 `.openclaw/`）
- 文件所有权对于运行 Gateway 网关的用户是正确的

### 步骤 3 — 运行 Doctor（迁移 + 服务修复）

在**新**机器上：

```bash
openclaw doctor
```

Doctor 是"安全可靠"的命令。它修复服务、应用配置迁移，并警告不匹配问题。

然后：

```bash
openclaw gateway restart
openclaw status
```

## 常见陷阱（以及如何避免）

### 陷阱：配置文件/状态目录不匹配

如果你在旧 Gateway 网关上使用了配置文件（或 `OPENCLAW_STATE_DIR`），而新 Gateway 网关使用了不同的配置，你会看到如下症状：

- 配置更改不生效
- 渠道丢失/已登出
- 会话历史为空

修复：使用你迁移的**相同**配置文件/状态目录运行 Gateway 网关/服务，然后重新运行：

```bash
openclaw doctor
```

### 陷阱：只复制 `openclaw.json`

`openclaw.json` 是不够的。许多提供商在以下位置存储状态：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

始终迁移整个 `$OPENCLAW_STATE_DIR` 文件夹。

### 陷阱：权限/所有权

如果你以 root 身份复制或更改了用户，Gateway 网关可能无法读取凭证/会话。

修复：确保状态目录 + 工作区由运行 Gateway 网关的用户拥有。

### 陷阱：在远程/本地模式之间迁移

- 如果你的 UI（WebUI/TUI）指向**远程** Gateway 网关，远程主机拥有会话存储 + 工作区。
- 迁移你的笔记本电脑不会移动远程 Gateway 网关的状态。

如果你处于远程模式，请迁移 **Gateway 网关主机**。

### 陷阱：备份中的密钥

`$OPENCLAW_STATE_DIR` 包含密钥（API 密钥、OAuth 令牌、WhatsApp 凭证）。将备份视为生产密钥：

- 加密存储
- 避免通过不安全的渠道共享
- 如果怀疑泄露，轮换密钥

## 验证检查清单

在新机器上，确认：

- `openclaw status` 显示 Gateway 网关正在运行
- 你的渠道仍然连接（例如 WhatsApp 不需要重新配对）
- 仪表板打开并显示现有会话
- 你的工作区文件（记忆、配置）存在

## 相关内容

- [Doctor](/gateway/doctor)
- [Gateway 网关故障排除](/gateway/troubleshooting)
- [OpenClaw 在哪里存储数据？](/help/faq#where-does-openclaw-store-its-data)
