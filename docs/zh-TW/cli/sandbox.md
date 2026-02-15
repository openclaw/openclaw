---
title: 沙箱 CLI
summary: "管理沙箱容器並檢查有效的沙箱策略"
read_when: "當您正在管理沙箱容器或偵錯沙箱/工具策略行為時。"
status: active
---

# 沙箱 CLI

管理基於 Docker 的沙箱容器，用於隔離的智慧代理執行。

## 總覽

OpenClaw 可以在隔離的 Docker 容器中執行智慧代理以確保安全性。 `sandbox` 命令可協助您管理這些容器，尤其是在更新或設定變更之後。

## 命令

### `openclaw sandbox explain`

檢查有效的沙箱模式/範圍/工作區存取、沙箱工具策略以及提升的閘門（帶有修復設定鍵路徑）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙箱容器及其狀態和設定。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**輸出內容包括：**

- 容器名稱和狀態（執行中/已停止）
- Docker 映像檔以及是否與設定匹配
- 存在時間（建立以來的時間）
- 閒置時間（上次使用以來的時間）
- 相關聯的工作階段/智慧代理

### `openclaw sandbox recreate`

移除沙箱容器以強制使用更新的映像檔/設定重新建立。

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**選項：**

- `--all`: 重新建立所有沙箱容器
- `--session <key>`: 為特定工作階段重新建立容器
- `--agent <id>`: 為特定智慧代理重新建立容器
- `--browser`: 僅重新建立瀏覽器容器
- `--force`: 跳過確認提示

**重要事項：** 容器將在下次使用智慧代理時自動重新建立。

## 使用案例

### 更新 Docker 映像檔後

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### 變更沙箱設定後

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### 變更 setupCommand 後

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 僅針對特定智慧代理

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 為什麼需要這個？

**問題：** 當您更新沙箱 Docker 映像檔或設定時：

- 現有容器會繼續使用舊設定執行
- 容器只會在閒置 24 小時後才被清除
- 經常使用的智慧代理會無限期地保持舊容器執行

**解決方案：** 使用 `openclaw sandbox recreate` 強制移除舊容器。當下次需要時，它們將會使用當前設定自動重新建立。

提示：優先使用 `openclaw sandbox recreate` 而非手動 `docker rm`。它使用 Gateway 的容器命名方式，並避免在範圍/工作階段鍵變更時發生不匹配。

## 設定

沙箱設定位於 `~/.openclaw/openclaw.json` 的 `agents.defaults.sandbox` 下（每個智慧代理的覆寫設定則在 `agents.list[].sandbox` 中）：

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

## 參閱

- [沙箱文件](/gateway/sandboxing)
- [智慧代理設定](/concepts/agent-workspace)
- [Doctor 命令](/gateway/doctor) - 檢查沙箱設定
