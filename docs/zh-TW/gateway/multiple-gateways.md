---
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: Multiple Gateways
---

# 多重閘道（相同主機）

大多數設置應該使用一個 Gateway，因為單一的 Gateway 可以處理多個消息連接和代理。如果您需要更強的隔離或冗餘（例如，救援機器人），請執行具有隔離設定檔/端口的獨立 Gateway。

## 隔離檢查清單（必填）

- `OPENCLAW_CONFIG_PATH` — 每個實例的設定檔
- `OPENCLAW_STATE_DIR` — 每個實例的會話、憑證、快取
- `agents.defaults.workspace` — 每個實例的工作區根目錄
- `gateway.port` (或 `--port`) — 每個實例的唯一識別
- 派生的埠（瀏覽器/畫布）不得重疊

如果這些是共享的，您將會遇到設定競爭和端口衝突。

## 建議：設定檔 (`--profile`)

Profiles 自動範圍 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 並為服務名稱添加後綴。

bash

# main

openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue

openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001

[[BLOCK_1]]

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Rescue-bot 指南

在同一主機上執行第二個 Gateway，並擁有自己的：

- profile/config
- state dir
- workspace
- base port (plus derived ports)

這樣可以讓救援機器人與主機器人隔離，以便在主機器人故障時進行除錯或應用設定變更。

埠間距：在基礎埠之間至少留有 20 個埠，以確保衍生的瀏覽器/畫布/CDP 埠不會發生衝突。

### 如何安裝 (救援機器人)

bash

# 主機器人（現有或全新，無 --profile 參數）

# 在 18789 端口執行 + Chrome CDC/Canvas/... 端口

openclaw onboard
openclaw gateway install

# 救援機器人（孤立的設定檔 + 端口）

openclaw --profile rescue onboard

# 注意事項：

# - 工作區名稱預設會加上 -rescue 後綴

# - 端口應至少為 18789 加上 20 個端口，

# 最好選擇完全不同的基礎端口，例如 19789，

# - 其餘的上線過程與正常情況相同

# 若在入門過程中未自動安裝服務，請執行以下指令

openclaw --profile rescue gateway install

## Port mapping (derived)

Base port = `gateway.port` (或 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 瀏覽器控制服務埠 = 基礎 + 2（僅限回環）
- 畫布主機在 Gateway HTTP 伺服器上提供服務（與 `gateway.port` 相同的埠）
- 瀏覽器設定 CDP 埠自動分配自 `browser.controlPort + 9 .. + 108`

如果您在設定或環境中覆寫了任何這些，必須確保它們在每個實例中保持唯一。

## 瀏覽器/CDP 註解（常見陷阱）

- 請**勿**將 `browser.cdpUrl` 鎖定為多個實例的相同值。
- 每個實例需要自己的瀏覽器控制埠和 CDP 範圍（從其閘道埠衍生）。
- 如果需要明確的 CDP 埠，請為每個實例設置 `browser.profiles.<name>.cdpPort`。
- 遠端 Chrome：使用 `browser.profiles.<name>.cdpUrl`（每個設定檔，每個實例）。

## Manual env example

bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001

## 快速檢查

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
