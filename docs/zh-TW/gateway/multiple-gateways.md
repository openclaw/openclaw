---
summary: "在同一主機上執行多個 OpenClaw Gateway (隔離、埠號和設定檔)"
read_when:
  - 在同一台機器上執行多個 Gateway
  - 每個 Gateway需要獨立的設定/狀態/埠號
title: "多個 Gateway"
---

# 多個 Gateway (同一主機)

大多數的設定應該使用一個 Gateway，因為單一 Gateway可以處理多個訊息連線和智慧代理。如果您需要更強的隔離或備援 (例如，救援機器人)，請執行具有獨立設定檔/埠號的單獨 Gateway。

## 隔離檢查清單 (必要)

- `OPENCLAW_CONFIG_PATH` — 每個實例的設定檔案
- `OPENCLAW_STATE_DIR` — 每個實例的工作階段、憑證、快取
- `agents.defaults.workspace` — 每個實例的工作區根目錄
- `gateway.port` (或 `--port`) — 每個實例唯一
- 衍生埠號 (瀏覽器/畫布) 不得重疊

如果這些被共享，您將遇到設定競爭和埠號衝突。

## 建議：設定檔 (`--profile`)

設定檔會自動設定 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 的作用域並為服務名稱加上後綴。

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

每個設定檔的服務：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 救援機器人指南

在同一主機上執行第二個 Gateway，並使用其自己的：

- 設定檔/設定
- 狀態目錄
- 工作區
- 基礎埠號 (加上衍生埠號)

這使得救援機器人與主要機器人隔離，因此當主要機器人停機時，它可以偵錯或應用設定變更。

埠號間距：在基礎埠號之間至少保留 20 個埠號，這樣衍生的瀏覽器/畫布/CDP 埠號永不衝突。

### 如何安裝 (救援機器人)

```bash
# 主要機器人 (現有或全新，不帶 --profile 參數)
# 運行在埠號 18789 + Chrome CDC/畫布/... 埠號
openclaw onboard
openclaw gateway install

# 救援機器人 (獨立的設定檔 + 埠號)
openclaw --profile rescue onboard
# 注意事項：
# - 工作區名稱預設將會後綴 -rescue
# - 埠號應至少為 18789 + 20 個埠號，
#   最好選擇完全不同的基礎埠號，例如 19789，
# - 新手導覽的其餘部分與正常情況相同

# 要安裝服務 (如果在新手導覽期間沒有自動發生)
openclaw --profile rescue gateway install
```

## 埠號映射 (衍生)

基礎埠號 = `gateway.port` (或 `OPENCLAW_GATEWAY_PORT` / `--port`)。

- 瀏覽器控制服務埠號 = 基礎 + 2 (僅限 loopback)
- `canvasHost.port = 基礎 + 4`
- 瀏覽器設定檔 CDP 埠號從 `browser.controlPort + 9 .. + 108` 自動分配

如果您在設定或環境變數中覆寫其中任何一個，則必須確保它們在每個實例中都是唯一的。

## 瀏覽器/CDP 注意事項 (常見陷阱)

- **不要**在多個實例上將 `browser.cdpUrl` 釘選到相同的值。
- 每個實例都需要自己的瀏覽器控制埠號和 CDP 範圍 (衍生自其 Gateway埠號)。
- 如果您需要明確的 CDP 埠號，請為每個實例設定 `browser.profiles.<name>.cdpPort`。
- 遠端 Chrome：使用 `browser.profiles.<name>.cdpUrl` (每個設定檔，每個實例)。

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
