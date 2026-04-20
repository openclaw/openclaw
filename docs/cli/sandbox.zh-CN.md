---
title: 沙盒 CLI
summary: "管理沙盒运行时并检查有效的沙盒策略"
read_when: "你正在管理沙盒运行时或调试沙盒/工具策略行为。"
status: active
---

# 沙盒 CLI

管理用于隔离代理执行的沙盒运行时。

## 概述

OpenClaw 可以在隔离的沙盒运行时中运行代理以提高安全性。`sandbox` 命令帮助你在更新或配置更改后检查和重新创建这些运行时。

目前，这通常意味着：

- Docker 沙盒容器
- 当 `agents.defaults.sandbox.backend = "ssh"` 时的 SSH 沙盒运行时
- 当 `agents.defaults.sandbox.backend = "openshell"` 时的 OpenShell 沙盒运行时

对于 `ssh` 和 OpenShell `remote`，重新创建比 Docker 更重要：

- 远程工作区在初始种子后是规范的
- `openclaw sandbox recreate` 会为选定范围删除该规范远程工作区
- 下次使用时会从当前本地工作区重新种子化

## 命令

### `openclaw sandbox explain`

检查**有效的**沙盒模式/范围/工作区访问、沙盒工具策略和提升的门控（带有修复配置键路径）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙盒运行时及其状态和配置。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # 仅列出浏览器容器
openclaw sandbox list --json     # JSON 输出
```

**输出包括：**

- 运行时名称和状态
- 后端（`docker`、`openshell` 等）
- 配置标签以及它是否与当前配置匹配
- 年龄（创建以来的时间）
- 空闲时间（上次使用以来的时间）
- 关联的会话/代理

### `openclaw sandbox recreate`

删除沙盒运行时以强制使用更新的配置重新创建。

```bash
openclaw sandbox recreate --all                # 重新创建所有容器
openclaw sandbox recreate --session main       # 特定会话
openclaw sandbox recreate --agent mybot        # 特定代理
openclaw sandbox recreate --browser            # 仅浏览器容器
openclaw sandbox recreate --all --force        # 跳过确认
```

**选项：**

- `--all`：重新创建所有沙盒容器
- `--session <key>`：为特定会话重新创建容器
- `--agent <id>`：为特定代理重新创建容器
- `--browser`：仅重新创建浏览器容器
- `--force`：跳过确认提示

**重要：** 当代理下次使用时，运行时会自动重新创建。

## 使用场景

### 更新 Docker 镜像后

```bash
# 拉取新镜像
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 更新配置以使用新镜像
# 编辑配置：agents.defaults.sandbox.docker.image（或 agents.list[].sandbox.docker.image）

# 重新创建容器
openclaw sandbox recreate --all
```

### 更改沙盒配置后

```bash
# 编辑配置：agents.defaults.sandbox.*（或 agents.list[].sandbox.*）

# 重新创建以应用新配置
openclaw sandbox recreate --all
```

### 更改 SSH 目标或 SSH 认证材料后

```bash
# 编辑配置：
# - agents.defaults.sandbox.backend
# - agents.defaults.sandbox.ssh.target
# - agents.defaults.sandbox.ssh.workspaceRoot
# - agents.defaults.sandbox.ssh.identityFile / certificateFile / knownHostsFile
# - agents.defaults.sandbox.ssh.identityData / certificateData / knownHostsData

openclaw sandbox recreate --all
```

对于核心 `ssh` 后端，重新创建会删除 SSH 目标上每个范围的远程工作区根目录。下次运行时会从本地工作区重新种子化。

### 更改 OpenShell 源、策略或模式后

```bash
# 编辑配置：
# - agents.defaults.sandbox.backend
# - plugins.entries.openshell.config.from
# - plugins.entries.openshell.config.mode
# - plugins.entries.openshell.config.policy

openclaw sandbox recreate --all
```

对于 OpenShell `remote` 模式，重新创建会删除该范围的规范远程工作区。下次运行时会从本地工作区重新种子化。

### 更改 setupCommand 后

```bash
openclaw sandbox recreate --all
# 或仅一个代理：
openclaw sandbox recreate --agent family
```

### 仅针对特定代理

```bash
# 仅更新一个代理的容器
openclaw sandbox recreate --agent alfred
```

## 为什么需要这个？

**问题：** 当你更新沙盒配置时：

- 现有运行时继续使用旧设置运行
- 运行时仅在 24 小时不活动后才会被修剪
- 经常使用的代理会无限期地保持旧运行时活跃

**解决方案：** 使用 `openclaw sandbox recreate` 强制删除旧运行时。它们将在下次需要时使用当前设置自动重新创建。

提示：优先使用 `openclaw sandbox recreate` 而不是手动后端特定的清理。它使用网关的运行时注册表，避免了范围/会话键更改时的不匹配。

## 配置

沙盒设置位于 `~/.openclaw/openclaw.json` 中的 `agents.defaults.sandbox` 下（每个代理的覆盖在 `agents.list[].sandbox` 中）：

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "backend": "docker", // docker, ssh, openshell
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... 更多 Docker 选项
        },
        "prune": {
          "idleHours": 24, // 24 小时空闲后自动修剪
          "maxAgeDays": 7, // 7 天后自动修剪
        },
      },
    },
  },
}
```

## 另请参阅

- [沙盒文档](/gateway/sandboxing)
- [代理配置](/concepts/agent-workspace)
- [Doctor 命令](/gateway/doctor) - 检查沙盒设置
