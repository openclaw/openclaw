---
title: 沙箱 CLI
summary: "管理沙箱容器並檢查生效中的沙箱策略"
read_when: "當您正在管理沙箱容器或對沙箱/工具策略行為進行除錯時。"
status: active
---

# 沙箱 CLI

管理用於隔離智慧代理執行的 Docker 型沙箱容器。

## 總覽

為了安全起見，OpenClaw 可以在隔離的 Docker 容器中執行智慧代理。`sandbox` 指令可協助您管理這些容器，特別是在更新或變更設定之後。

## 指令

### `openclaw sandbox explain`

檢查**生效中**的沙箱模式/範圍/工作區存取權限、沙箱工具策略以及提升的閘門（包含修復設定的鍵值路徑）。

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
openclaw sandbox list --browser  # 僅列出瀏覽器容器
openclaw sandbox list --json     # JSON 輸出
```

**輸出包含：**

- 容器名稱與狀態 (執行中/已停止)
- Docker 映像檔以及是否與設定相符
- 存在時間 (自建立以來經過的時間)
- 閒置時間 (自上次使用以來經過的時間)
- 關聯的工作階段/智慧代理

### `openclaw sandbox recreate`

刪除沙箱容器，以使用更新後的映像檔/設定強制重新建立。

```bash
openclaw sandbox recreate --all                # 重新建立所有容器
openclaw sandbox recreate --session main       # 特定工作階段
openclaw sandbox recreate --agent mybot        # 特定智慧代理
openclaw sandbox recreate --browser            # 僅限瀏覽器容器
openclaw sandbox recreate --all --force        # 跳過確認步驟
```

**選項：**

- `--all`：重新建立所有沙箱容器
- `--session <key>`：重新建立特定工作階段的容器
- `--agent <id>`：重新建立特定智慧代理的容器
- `--browser`：僅重新建立瀏覽器容器
- `--force`：跳過確認提示

**重要提示：** 容器會在下次使用智慧代理時自動重新建立。

## 使用情境

### 更新 Docker 映像檔後

```bash
# 拉取新映像檔
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 更新設定以使用新映像檔
# 編輯設定：agents.defaults.sandbox.docker.image (或 agents.list[].sandbox.docker.image)

# 重新建立容器
openclaw sandbox recreate --all
```

### 變更沙箱設定後

```bash
# 編輯設定：agents.defaults.sandbox.* (或 agents.list[].sandbox.*)

# 重新建立以套用新設定
openclaw sandbox recreate --all
```

### 變更 setupCommand 後

```bash
openclaw sandbox recreate --all
# 或僅針對單一智慧代理：
openclaw sandbox recreate --agent family
```

### 僅針對特定智慧代理

```bash
# 僅更新一個智慧代理的容器
openclaw sandbox recreate --agent alfred
```

## 為什麼需要這個？

**問題：** 當您更新沙箱 Docker 映像檔或設定時：

- 現有的容器會繼續以舊的設定執行
- 容器僅在閒置 24 小時後才會被自動清除
- 經常使用的智慧代理會讓舊容器無限期地持續執行

**解決方案：** 使用 `openclaw sandbox recreate` 強制移除舊容器。它們會在下次需要時，根據目前的設定自動重新建立。

提示：建議優先使用 `openclaw sandbox recreate` 而非手動執行 `docker rm`。它使用 Gateway 的容器命名規則，並避免在範圍/工作階段鍵值變更時發生不匹配的情況。

## 設定

沙箱設定位於 `~/.openclaw/openclaw.json` 的 `agents.defaults.sandbox` 路徑下（個別智慧代理的覆寫則位於 `agents.list[].sandbox`）：

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
          // ... 更多 Docker 選項
        },
        "prune": {
          "idleHours": 24, // 閒置 24 小時後自動清除
          "maxAgeDays": 7, // 7 天後自動清除
        },
      },
    },
  },
}
```

## 延伸閱讀

- [沙箱文件](/gateway/sandboxing)
- [智慧代理設定](/concepts/agent-workspace)
- [Doctor 指令](/gateway/doctor) - 檢查沙箱設置
