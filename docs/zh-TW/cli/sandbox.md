---
title: Sandbox CLI
summary: Manage sandbox containers and inspect effective sandbox policy
read_when: You are managing sandbox containers or debugging sandbox/tool-policy behavior.
status: active
---

# Sandbox CLI

管理基於 Docker 的沙盒容器，以進行隔離的代理執行。

## 概覽

OpenClaw 可以在隔離的 Docker 容器中執行代理，以提升安全性。`sandbox` 指令可協助你管理這些容器，特別是在更新或設定變更後。

## 指令

### `openclaw sandbox explain`

檢查 **實際生效的** 沙盒模式／範圍／工作區存取權限、沙盒工具政策，以及提升權限的關卡（含修正設定的金鑰路徑）。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

列出所有沙盒容器及其狀態與設定。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**輸出包含：**

- 容器名稱與狀態（執行中/已停止）
- Docker 映像檔及是否符合設定
- 存活時間（建立後經過時間）
- 閒置時間（最後使用後經過時間）
- 關聯的工作階段/代理程式

### `openclaw sandbox recreate`

移除沙盒容器以強制使用更新的映像檔/設定重新建立。

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**選項：**

- `--all`：重新建立所有沙盒容器
- `--session <key>`：重新建立特定會話的容器
- `--agent <id>`：重新建立特定代理的容器
- `--browser`：僅重新建立瀏覽器容器
- `--force`：跳過確認提示

**重要：** 容器會在代理下次使用時自動重新建立。

## 使用案例

### 更新 Docker 映像檔後

bash

# 拉取新映像檔

docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 更新設定以使用新映像檔

# 編輯設定：agents.defaults.sandbox.docker.image（或 agents.list[].sandbox.docker.image）

# 重新建立容器

openclaw sandbox recreate --all

### 變更 sandbox 設定後

bash

# 編輯設定：agents.defaults.sandbox._（或 agents.list[].sandbox._）

# 重新建立以套用新設定

openclaw sandbox recreate --all

### 變更 setupCommand 後

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 僅針對特定代理人

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 為什麼需要這個？

**問題：** 當你更新 sandbox Docker 映像檔或設定時：

- 現有的容器會繼續以舊設定執行
- 容器只有在 24 小時無活動後才會被清除
- 經常使用的代理程式會讓舊容器無限期持續執行

**解決方案：** 使用 `openclaw sandbox recreate` 強制移除舊容器。當下次需要時，容器會自動以最新設定重新建立。

提示：建議使用 `openclaw sandbox recreate` 取代手動 `docker rm`。它使用 Gateway 的容器命名，並避免在範圍/會話金鑰變更時發生不匹配。

## 設定

沙盒設定位於 `~/.openclaw/openclaw.json` 的 `agents.defaults.sandbox` 下（每個代理的覆寫設定放在 `agents.list[].sandbox`）：

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

## 參考資料

- [沙盒文件](/gateway/sandboxing)
- [代理設定](/concepts/agent-workspace)
- [Doctor 指令](/gateway/doctor) - 檢查沙盒設定是否正確
