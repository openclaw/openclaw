---
title: Sandbox CLI
summary: Manage sandbox containers and inspect effective sandbox policy
read_when: You are managing sandbox containers or debugging sandbox/tool-policy behavior.
status: active
---

# Sandbox CLI

管理基於 Docker 的沙盒容器以進行隔離的代理執行。

## 概述

OpenClaw 可以在隔離的 Docker 容器中執行代理，以增強安全性。`sandbox` 命令幫助您管理這些容器，特別是在更新或設定變更後。

## Commands

### `openclaw sandbox explain`

檢查 **有效的** 沙盒模式/範圍/工作區存取、沙盒工具政策，以及提升的閘道（包含修正設定金鑰路徑）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙盒容器及其狀態和設定。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**輸出包括：**

- 容器名稱和狀態（執行中/已停止）
- Docker 映像及其是否符合設定
- 年齡（創建以來的時間）
- 空閒時間（自上次使用以來的時間）
- 相關的會話/代理

### `openclaw sandbox recreate`

移除沙盒容器以強制使用更新的映像/設定重新創建。

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**選項：**

- `--all`: 重新建立所有沙盒容器
- `--session <key>`: 重新建立特定會話的容器
- `--agent <id>`: 重新建立特定代理的容器
- `--browser`: 只重新建立瀏覽器容器
- `--force`: 跳過確認提示

**重要：** 當代理下次使用時，容器會自動重新創建。

## 使用案例

### 更新 Docker 映像後

bash

# 下載新映像

docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 更新設定以使用新映像

# 編輯設定：agents.defaults.sandbox.docker.image (或 agents.list[].sandbox.docker.image)

# 重新建立容器

openclaw sandbox recreate --all

### 更改沙盒設定後

bash

# 編輯設定：agents.defaults.sandbox._ (或 agents.list[].sandbox._)

# 重新建立以應用新設定

openclaw sandbox recreate --all

### 更改 setupCommand 後

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 僅限特定代理人使用

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 為什麼需要這個？

**問題：** 當您更新沙盒 Docker 映像或設定時：

- 現有的容器繼續以舊設定執行
- 容器僅在 24 小時不活動後才會被清除
- 定期使用的代理會無限期保持舊容器執行

**解決方案：** 使用 `openclaw sandbox recreate` 強制移除舊的容器。當下次需要時，它們將根據當前設定自動重新創建。

提示：建議使用 `openclaw sandbox recreate` 而不是手動的 `docker rm`。它使用 Gateway 的容器命名，並避免在範圍/會話金鑰變更時出現不匹配。

## Configuration

Sandbox 設定位於 `~/.openclaw/openclaw.json` 下的 `agents.defaults.sandbox`（每個代理的覆蓋設定在 `agents.list[].sandbox` 中）：

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
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## 另請參閱

- [沙盒文件](/gateway/sandboxing)
- [代理設定](/concepts/agent-workspace)
- [Doctor 指令](/gateway/doctor) - 檢查沙盒設置
