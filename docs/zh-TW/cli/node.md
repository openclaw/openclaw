---
summary: CLI reference for `openclaw node` (headless node host)
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
title: node
---

# `openclaw node`

執行一個**無頭節點主機**，該主機連接到 Gateway WebSocket，並在此機器上暴露 `system.run` / `system.which`。

## 為什麼要使用節點主機？

當你想讓代理程式在你的網路中**於其他機器上執行指令**，但不想在那些機器上安裝完整的 macOS 伴侶應用程式時，請使用節點主機。

常見使用情境：

- 在遠端 Linux/Windows 主機（建置伺服器、實驗室機器、NAS）上執行指令。
- 在閘道器上保持 exec **沙盒化**，但將核准的執行委派給其他主機。
- 提供輕量、無頭的執行目標，適用於自動化或 CI 節點。

執行仍受 **exec 核准** 及節點主機上的每個代理允許清單保護，因此您可以保持指令存取範圍明確且具體。

## 瀏覽器代理（零設定）

節點主機會自動廣播瀏覽器代理，前提是 `browser.enabled` 未在節點上被禁用。這讓代理能在該節點上使用瀏覽器自動化，無需額外設定。

如有需要，可在節點上禁用它：

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 執行（前景）

```bash
openclaw node run --host <gateway-host> --port 18789
```

選項：

- `--host <host>`：Gateway WebSocket 主機（預設值：`127.0.0.1`）
- `--port <port>`：Gateway WebSocket 連接埠（預設值：`18789`）
- `--tls`：對 Gateway 連線使用 TLS
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋（sha256）
- `--node-id <id>`：覆寫節點 ID（會清除配對 token）
- `--display-name <name>`：覆寫節點顯示名稱

## 節點主機的 Gateway 認證

`openclaw node run` 和 `openclaw node install` 從設定檔/環境變數解析 gateway 認證（節點指令中無 `--token`/`--password` 旗標）：

- 優先檢查 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`。
- 接著本地設定備援：`gateway.auth.token` / `gateway.auth.password`。
- 在本地模式下，節點主機刻意不繼承 `gateway.remote.token` / `gateway.remote.password`。
- 若透過 SecretRef 明確設定 `gateway.auth.token` / `gateway.auth.password` 且無法解析，節點認證解析將失敗並封閉（不會有遠端備援遮蔽）。
- 在 `gateway.mode=remote` 中，遠端用戶端欄位（`gateway.remote.token` / `gateway.remote.password`）也依遠端優先規則具備資格。
- 舊版 `CLAWDBOT_GATEWAY_*` 環境變數在節點主機認證解析時被忽略。

## 服務（背景）

安裝無頭節點主機作為使用者服務。

```bash
openclaw node install --host <gateway-host> --port 18789
```

選項：

- `--host <host>`：Gateway WebSocket 主機（預設值：`127.0.0.1`）
- `--port <port>`：Gateway WebSocket 連接埠（預設值：`18789`）
- `--tls`：對 Gateway 連線使用 TLS
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋（sha256）
- `--node-id <id>`：覆寫節點 ID（會清除配對 token）
- `--display-name <name>`：覆寫節點顯示名稱
- `--runtime <runtime>`：服務執行環境（`node` 或 `bun`）
- `--force`：若已安裝則重新安裝/覆寫

管理服務：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 作為前景節點主機（無服務）。

服務指令接受 `--json` 以產生機器可讀的輸出。

## 配對

第一次連線會在閘道器上建立一個待處理的裝置配對請求 (`role: node`)。
請透過以下方式批准：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

節點主機將其節點 ID、token、顯示名稱及閘道連線資訊儲存在 `~/.openclaw/node.json`。

## 執行批准

`system.run` 受本地執行批准控管：

- `~/.openclaw/exec-approvals.json`
- [執行批准](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（從閘道編輯）
