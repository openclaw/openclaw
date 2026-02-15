---
summary: "在單一主機上執行多個 OpenClaw Gateway（隔離、連接埠與設定檔）"
read_when:
  - 在同一台機器上執行多個 Gateway
  - 每個 Gateway 需要獨立的設定/狀態/連接埠
title: "多個 Gateway"
---

# 多個 Gateway（同一台主機）

大多數設定應使用單個 Gateway，因為單個 Gateway 即可處理多個通訊連線與智慧代理。如果你需要更強的隔離性或冗餘（例如救援機器人），請執行具有獨立設定檔/連接埠的個別 Gateway。

## 隔離檢查清單（必要）

- `OPENCLAW_CONFIG_PATH` — 每個執行個體的設定檔案
- `OPENCLAW_STATE_DIR` — 每個執行個體的工作階段、憑證、快取
- `agents.defaults.workspace` — 每個執行個體的工作區根目錄
- `gateway.port` (或 `--port`) — 每個執行個體唯一的連接埠
- 衍生連接埠（瀏覽器/畫布）不得重疊

如果共用這些項目，將會遇到設定競態與連接埠衝突。

## 建議做法：設定檔 (`--profile`)

設定檔會自動界定 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 的範圍，並為服務名稱加上後綴。

```bash
# 主執行個體
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# 救援執行個體
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

依設定檔區分的服務：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 救援機器人指南

在同一台主機上執行第二個 Gateway，並擁有獨立的：

- 設定檔/設定
- 狀態目錄
- 工作區
- 基礎連接埠（以及衍生連接埠）

這能讓救援機器人與主機器人保持隔離，以便在主機器人故障時進行除錯或套用設定變更。

連接埠間距：基礎連接埠之間請至少保留 20 個連接埠，以確保衍生的瀏覽器/畫布/CDP 連接埠不會發生碰撞。

### 如何安裝（救援機器人）

```bash
# 主機器人（現有的或全新的，不帶 --profile 參數）
# 執行於連接埠 18789 + Chrome CDC/畫布/... 連接埠
openclaw onboard
openclaw gateway install

# 救援機器人（隔離的設定檔 + 連接埠）
openclaw --profile rescue onboard
# 附註：
# - 工作區名稱預設會加上 -rescue 後綴
# - 連接埠應至少為 18789 + 20 個連接埠，
#   建議選擇完全不同的基礎連接埠，例如 19789，
# - 其餘的新手導覽流程與正常情況相同

# 安裝服務（如果新手導覽期間未自動執行）
openclaw --profile rescue gateway install
```

## 連接埠對應（衍生）

基礎連接埠 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）。

- 瀏覽器控制服務連接埠 = 基礎連接埠 + 2 (僅限 local loopback)
- `canvasHost.port = 基礎連接埠 + 4`
- 瀏覽器設定檔 CDP 連接埠會從 `browser.controlPort + 9 .. + 108` 自動分配。

如果你在設定或環境變數中覆寫了其中任何一項，必須確保每個執行個體的設定都是唯一的。

## 瀏覽器/CDP 注意事項（常見陷阱）

- **請勿**在多個執行個體上將 `browser.cdpUrl` 固定為相同的值。
- 每個執行個體都需要自己的瀏覽器控制連接埠和 CDP 範圍（衍生自其 Gateway 連接埠）。
- 如果你需要明確的 CDP 連接埠，請為每個執行個體設定 `browser.profiles.<name>.cdpPort`。
- 遠端 Chrome：使用 `browser.profiles.<name>.cdpUrl`（每個設定檔、每個執行個體）。

## 手動環境變數範例

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## 快速檢查

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
