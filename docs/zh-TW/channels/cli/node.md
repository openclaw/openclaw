---
summary: CLI reference for `openclaw node` (headless node host)
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
title: node
---

`openclaw node`

執行一個 **無頭節點主機**，連接到 Gateway WebSocket 並在此機器上公開 `system.run` / `system.which`。

## 為什麼要使用節點主機？

當你希望代理在你的網路中**在其他機器上執行命令**而不需要在那裡安裝完整的 macOS 伴隨應用程式時，請使用節點主機。

常見的使用案例：

- 在遠端 Linux/Windows 主機上執行指令（建置伺服器、實驗室機器、NAS）。
- 在閘道器上保持執行 **sandboxed**，但將經批准的執行委派給其他主機。
- 提供一個輕量級、無頭的執行目標，以便於自動化或 CI 節點使用。

執行仍然受到 **exec approvals** 和每個代理的允許清單的保護，因此您可以保持命令訪問的範圍和明確性。

## 瀏覽器代理 (零設定)

如果 `browser.enabled` 在節點上未被禁用，則節點主機會自動廣告瀏覽器代理。這使得代理可以在該節點上使用瀏覽器自動化，而無需額外的設定。

如果需要，請在節點上禁用它：

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

Options:

- `--host <host>`: Gateway WebSocket 主機 (預設: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 端口 (預設: `18789`)
- `--tls`: 使用 TLS 進行網關連接
- `--tls-fingerprint <sha256>`: 預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`: 覆蓋節點 ID (清除配對 token)
- `--display-name <name>`: 覆蓋節點顯示名稱

## Gateway 認證用於節點主機

`openclaw node run` 和 `openclaw node install` 從設定/環境中解析網關認證（在節點命令上沒有 `--token`/`--password` 標誌）：

- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` 會首先被檢查。
- 然後是本地設定的回退：`gateway.auth.token` / `gateway.auth.password`。
- 在本地模式下，節點主機故意不繼承 `gateway.remote.token` / `gateway.remote.password`。
- 如果 `gateway.auth.token` / `gateway.auth.password` 是通過 SecretRef 明確設定且未解析，則節點身份驗證解析將失敗（不會有遠端回退遮罩）。
- 在 `gateway.mode=remote` 中，遠端用戶端欄位 (`gateway.remote.token` / `gateway.remote.password`) 也根據遠端優先規則符合資格。
- 過時的 `CLAWDBOT_GATEWAY_*` 環境變數在節點主機身份驗證解析中將被忽略。

## Service (background)

安裝無頭節點主機作為使用者服務。

```bash
openclaw node install --host <gateway-host> --port 18789
```

[[BLOCK_1]]

- `--host <host>`: Gateway WebSocket 主機 (預設: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 埠 (預設: `18789`)
- `--tls`: 使用 TLS 進行網關連接
- `--tls-fingerprint <sha256>`: 預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`: 覆蓋節點 ID (清除配對 token)
- `--display-name <name>`: 覆蓋節點顯示名稱
- `--runtime <runtime>`: 服務執行時 (`node` 或 `bun`)
- `--force`: 如果已安裝則重新安裝/覆蓋

管理服務：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 作為前景節點主機（無服務）。

服務命令接受 `--json` 以獲取機器可讀的輸出。

## 配對

第一次連接會在 Gateway 上創建一個待處理的設備配對請求 (`role: node`)。請通過以下方式批准它：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

節點主機將其節點 ID、token、顯示名稱和閘道連接資訊儲存在 `~/.openclaw/node.json`。

## Exec approvals

`system.run` 受到當地執行批准的限制：

- `~/.openclaw/exec-approvals.json`
- [執行批准](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (從 Gateway 編輯)
