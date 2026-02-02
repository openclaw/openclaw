---
read_when: 你正在管理沙箱容器或调试沙箱/工具策略行为。
status: active
summary: 管理沙箱容器并检查生效的沙箱策略
title: Sandbox CLI
x-i18n:
  generated_at: "2026-02-01T20:21:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6e1186f26c77e188206ce5e198ab624d6b38bc7bb7c06e4d2281b6935c39e347
  source_path: cli/sandbox.md
  workflow: 14
---

# Sandbox CLI

管理基于 Docker 的沙箱容器，用于隔离智能体执行。

## 概述

OpenClaw 可以在隔离的 Docker 容器中运行智能体以确保安全性。`sandbox` 命令帮助你管理这些容器，尤其是在更新或配置变更之后。

## 命令

### `openclaw sandbox explain`

检查**生效的**沙箱模式/作用域/工作区访问权限、沙箱工具策略以及提权门控（附带修复建议的配置键路径）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙箱容器及其状态和配置。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # 仅列出浏览器容器
openclaw sandbox list --json     # JSON 输出
```

**输出包括：**

- 容器名称和状态（运行中/已停止）
- Docker 镜像及其是否与配置匹配
- 存在时间（自创建以来的时长）
- 空闲时间（自上次使用以来的时长）
- 关联的会话/智能体

### `openclaw sandbox recreate`

移除沙箱容器，以便使用更新的镜像/配置强制重新创建。

```bash
openclaw sandbox recreate --all                # 重新创建所有容器
openclaw sandbox recreate --session main       # 指定会话
openclaw sandbox recreate --agent mybot        # 指定智能体
openclaw sandbox recreate --browser            # 仅浏览器容器
openclaw sandbox recreate --all --force        # 跳过确认提示
```

**选项：**

- `--all`：重新创建所有沙箱容器
- `--session <key>`：重新创建指定会话的容器
- `--agent <id>`：重新创建指定智能体的容器
- `--browser`：仅重新创建浏览器容器
- `--force`：跳过确认提示

**重要提示：** 容器会在智能体下次使用时自动重新创建。

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

### 更改沙箱配置后

```bash
# 编辑配置：agents.defaults.sandbox.*（或 agents.list[].sandbox.*）

# 重新创建以应用新配置
openclaw sandbox recreate --all
```

### 更改 setupCommand 后

```bash
openclaw sandbox recreate --all
# 或仅针对某个智能体：
openclaw sandbox recreate --agent family
```

### 仅针对特定智能体

```bash
# 仅更新某个智能体的容器
openclaw sandbox recreate --agent alfred
```

## 为什么需要这样做？

**问题：** 当你更新沙箱 Docker 镜像或配置时：

- 现有容器会继续使用旧设置运行
- 容器仅在空闲 24 小时后才会被清理
- 经常使用的智能体会无限期地保持旧容器运行

**解决方案：** 使用 `openclaw sandbox recreate` 强制移除旧容器。它们会在下次需要时自动使用当前设置重新创建。

提示：建议使用 `openclaw sandbox recreate` 而非手动执行 `docker rm`。它使用 Gateway网关的容器命名规则，避免在作用域/会话键发生变化时出现不匹配问题。

## 配置

沙箱设置位于 `~/.openclaw/openclaw.json` 中的 `agents.defaults.sandbox` 下（按智能体覆盖的配置放在 `agents.list[].sandbox` 中）：

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... 更多 Docker 选项
        },
        "prune": {
          "idleHours": 24, // 空闲 24 小时后自动清理
          "maxAgeDays": 7, // 7 天后自动清理
        },
      },
    },
  },
}
```

## 另请参阅

- [沙箱文档](/gateway/sandboxing)
- [智能体配置](/concepts/agent-workspace)
- [Doctor 命令](/gateway/doctor) - 检查沙箱设置
