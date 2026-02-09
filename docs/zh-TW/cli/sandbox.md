---
title: 沙箱 CLI
summary: "管理沙箱容器並檢視有效的沙箱政策"
read_when: "當你正在管理沙箱容器或除錯沙箱／工具政策行為時。"
status: active
---

# 沙箱 CLI

管理以 Docker 為基礎的沙箱容器，用於隔離的代理程式執行。

## 概覽

OpenClaw 可以在隔離的 Docker 容器中執行代理程式以提升安全性。`sandbox` 指令可協助你管理這些容器，特別是在更新或設定變更之後。 12. `sandbox` 指令可協助你管理這些容器，特別是在更新或設定變更之後。

## 指令

### `openclaw sandbox explain`

13. 檢視**實際生效**的沙箱模式／範圍／工作區存取、沙箱工具原則，以及提升的閘道（含修復用的設定鍵路徑）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙箱容器及其狀態與設定。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**輸出包含：**

- 容器名稱與狀態（執行中／已停止）
- Docker 映像與是否符合設定
- 14. 年齡（自建立以來的時間）
- 閒置時間（自上次使用以來的時間）
- 15. 關聯的工作階段／代理

### `openclaw sandbox recreate`

移除沙箱容器以強制使用更新後的映像／設定重新建立。

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**選項：**

- `--all`：重新建立所有沙箱容器
- `--session <key>`：重新建立特定工作階段的容器
- `--agent <id>`：重新建立特定代理程式的容器
- `--browser`：僅重新建立瀏覽器容器
- `--force`：略過確認提示

**重要事項：** 當代理程式下次使用時，容器會自動重新建立。

## 使用情境

### 更新 Docker 映像之後

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### 變更沙箱設定之後

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### 變更 setupCommand 之後

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 16. 僅針對特定代理

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 為什麼需要這樣做？

**問題：** 當你更新沙箱 Docker 映像或設定時：

- 既有容器會持續以舊設定執行
- 容器僅會在 24 小時未使用後才被清除
- 經常使用的代理程式會無限期地維持舊容器在執行

**解決方案：** 使用 `openclaw sandbox recreate` 強制移除舊容器。它們會在下次需要時，以目前設定自動重新建立。 17. 下次需要時，會依目前設定自動重新建立。

提示：優先使用 `openclaw sandbox recreate`，而非手動 `docker rm`。它會使用 Gateway 閘道器的容器命名，並在範圍／工作階段金鑰變更時避免不相符。 18. 它使用 Gateway 的容器命名，並在範圍／工作階段鍵變更時避免不相符。

## 設定

沙箱設定位於 `~/.openclaw/openclaw.json` 的 `agents.defaults.sandbox` 之下（每個代理程式的覆寫設定位於 `agents.list[].sandbox`）：

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

## 19. 另請參閱

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - 檢查沙箱設定
