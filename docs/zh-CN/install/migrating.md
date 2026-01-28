---
read_when:
  - 你正在将 OpenClaw 迁移到新的笔记本/服务器
  - 你想保留会话、认证和渠道登录状态（WhatsApp 等）
summary: 将 OpenClaw 安装从一台机器迁移到另一台
title: 迁移指南
x-i18n:
  generated_at: "2026-02-01T21:08:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 604d862c4bf86e7924d09028db8cc2514ca6f1d64ebe8bb7d1e2dde57ef70caa
  source_path: install/migrating.md
  workflow: 14
---

# 将 OpenClaw 迁移到新机器

本指南介绍如何将 OpenClaw Gateway网关从一台机器迁移到另一台，**无需重新进行新手引导**。

迁移在概念上很简单：

- 复制**状态目录**（`$OPENCLAW_STATE_DIR`，默认：`~/.openclaw/`）— 包含配置、认证、会话和渠道状态。
- 复制你的**工作区**（默认 `~/.openclaw/workspace/`）— 包含你的智能体文件（记忆、提示词等）。

但在**配置文件**、**权限**和**不完整复制**方面有一些常见的坑。

## 开始之前（你要迁移什么）

### 1) 确认你的状态目录

大多数安装使用默认路径：

- **状态目录：** `~/.openclaw/`

但如果你使用了以下选项，路径可能不同：

- `--profile <name>`（通常变为 `~/.openclaw-<profile>/`）
- `OPENCLAW_STATE_DIR=/some/path`

如果不确定，在**旧**机器上运行：

```bash
openclaw status
```

在输出中查找 `OPENCLAW_STATE_DIR` / profile 的相关信息。如果你运行了多个 Gateway网关，请对每个配置文件重复操作。

### 2) 确认你的工作区

常见默认路径：

- `~/.openclaw/workspace/`（推荐工作区）
- 你创建的自定义文件夹

你的工作区是 `MEMORY.md`、`USER.md` 和 `memory/*.md` 等文件所在的位置。

### 3) 了解你将保留什么

如果你**同时**复制状态目录和工作区，你将保留：

- Gateway网关配置（`openclaw.json`）
- 认证配置 / API 密钥 / OAuth 令牌
- 会话历史 + 智能体状态
- 渠道状态（例如 WhatsApp 登录/会话）
- 你的工作区文件（记忆、Skills 笔记等）

如果你**只**复制工作区（例如通过 Git），你将**不会**保留：

- 会话
- 凭据
- 渠道登录状态

这些存储在 `$OPENCLAW_STATE_DIR` 下。

## 迁移步骤（推荐）

### 步骤 0 — 备份（旧机器）

在**旧**机器上，先停止 Gateway网关以确保复制过程中文件不会变动：

```bash
openclaw gateway stop
```

（可选但推荐）归档状态目录和工作区：

```bash
# 如果使用了配置文件或自定义路径，请调整路径
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

如果你有多个配置文件/状态目录（例如 `~/.openclaw-main`、`~/.openclaw-work`），请分别归档。

### 步骤 1 — 在新机器上安装 OpenClaw

在**新**机器上安装 CLI（如有需要也安装 Node）：

- 参见：[安装](/install)

在此阶段，新手引导创建一个全新的 `~/.openclaw/` 是没问题的 — 你将在下一步覆盖它。

### 步骤 2 — 将状态目录 + 工作区复制到新机器

**同时**复制：

- `$OPENCLAW_STATE_DIR`（默认 `~/.openclaw/`）
- 你的工作区（默认 `~/.openclaw/workspace/`）

常用方法：

- 通过 `scp` 传输压缩包并解压
- 通过 SSH 使用 `rsync -a`
- 外部存储设备

复制后确保：

- 隐藏目录已包含在内（例如 `.openclaw/`）
- 文件所有权对于运行 Gateway网关的用户是正确的

### 步骤 3 — 运行 Doctor（迁移 + 服务修复）

在**新**机器上：

```bash
openclaw doctor
```

Doctor 是"安全可靠"的命令。它会修复服务、应用配置迁移并警告不匹配的问题。

然后：

```bash
openclaw gateway restart
openclaw status
```

## 常见的坑（及如何避免）

### 坑：配置文件 / 状态目录不匹配

如果旧 Gateway网关使用了配置文件（或 `OPENCLAW_STATE_DIR`），而新 Gateway网关使用了不同的路径，你会看到以下症状：

- 配置更改不生效
- 渠道缺失 / 已登出
- 会话历史为空

修复：使用与迁移相同的配置文件/状态目录来运行 Gateway网关/服务，然后重新运行：

```bash
openclaw doctor
```

### 坑：只复制了 `openclaw.json`

`openclaw.json` 是不够的。许多提供商将状态存储在：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

始终迁移整个 `$OPENCLAW_STATE_DIR` 文件夹。

### 坑：权限 / 所有权

如果你以 root 身份复制或更换了用户，Gateway网关可能无法读取凭据/会话。

修复：确保状态目录 + 工作区的所有者是运行 Gateway网关的用户。

### 坑：在远程/本地模式之间迁移

- 如果你的界面（WebUI/TUI）指向**远程** Gateway网关，则远程主机拥有会话存储 + 工作区。
- 迁移你的笔记本不会移动远程 Gateway网关的状态。

如果你处于远程模式，请迁移 **Gateway网关主机**。

### 坑：备份中的密钥

`$OPENCLAW_STATE_DIR` 包含密钥（API 密钥、OAuth 令牌、WhatsApp 凭据）。请将备份视为生产密钥：

- 加密存储
- 避免通过不安全的渠道传输
- 如果怀疑泄露，请轮换密钥

## 验证清单

在新机器上确认：

- `openclaw status` 显示 Gateway网关正在运行
- 你的渠道仍然处于连接状态（例如 WhatsApp 无需重新配对）
- 仪表盘可以打开并显示现有会话
- 你的工作区文件（记忆、配置）已存在

## 相关内容

- [Doctor](/gateway/doctor)
- [Gateway网关故障排除](/gateway/troubleshooting)
- [OpenClaw 将数据存储在哪里？](/help/faq#where-does-openclaw-store-its-data)
