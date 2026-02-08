---
summary: 「在同一台主機上執行多個 OpenClaw Gateway 閘道器（隔離、連接埠與設定檔）」
read_when:
  - 在同一台機器上執行多個 Gateway 閘道器
  - 你需要每個 Gateway 閘道器都有隔離的設定 / 狀態 / 連接埠
title: 「多個 Gateway 閘道器」
x-i18n:
  source_path: gateway/multiple-gateways.md
  source_hash: 09b5035d4e5fb97c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:05Z
---

# 多個 Gateway 閘道器（同一主機）

大多數設定應該只使用一個 Gateway 閘道器，因為單一 Gateway 閘道器即可處理多個訊息連線與代理程式。若你需要更強的隔離或備援（例如救援機器人），請使用彼此隔離的設定檔與連接埠來執行多個獨立的 Gateway 閘道器。

## 隔離檢查清單（必要）

- `OPENCLAW_CONFIG_PATH` — 每個實例獨立的設定檔
- `OPENCLAW_STATE_DIR` — 每個實例獨立的工作階段、憑證、快取
- `agents.defaults.workspace` — 每個實例獨立的工作區根目錄
- `gateway.port`（或 `--port`）— 每個實例必須唯一
- 衍生的連接埠（瀏覽器 / 畫布）不得重疊

若上述項目有任何共用，將會發生設定競爭與連接埠衝突。

## 建議作法：設定檔（profiles，`--profile`）

設定檔會自動界定 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`，並為服務名稱加上尾碼。

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

在同一台主機上執行第二個 Gateway 閘道器，並為其配置獨立的：

- 設定檔 / 設定
- 狀態目錄
- 工作區
- 基礎連接埠（以及其衍生連接埠）

如此可讓救援機器人與主要機器人完全隔離，當主要機器人停機時，仍能進行除錯或套用設定變更。

連接埠間距：基礎連接埠之間至少預留 20 個連接埠，確保衍生的瀏覽器 / 畫布 / CDP 連接埠永不衝突。

### 如何安裝（救援機器人）

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## 連接埠對應（衍生）

基礎連接埠 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）。

- 瀏覽器控制服務連接埠 = 基礎連接埠 + 2（僅限 local loopback）
- `canvasHost.port = base + 4`
- 瀏覽器設定檔的 CDP 連接埠會自動從 `browser.controlPort + 9 .. + 108` 配置

若你在設定或環境變數中覆寫任何一項，必須確保每個實例都使用唯一的值。

## 瀏覽器 / CDP 注意事項（常見踩雷點）

- **不要** 在多個實例上將 `browser.cdpUrl` 固定為相同的值。
- 每個實例都需要自己的瀏覽器控制連接埠與 CDP 範圍（由其 Gateway 閘道器連接埠衍生）。
- 若需要明確指定 CDP 連接埠，請為每個實例設定 `browser.profiles.<name>.cdpPort`。
- 遠端 Chrome：使用 `browser.profiles.<name>.cdpUrl`（每個設定檔、每個實例）。

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
