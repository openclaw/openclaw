---
summary: "`openclaw node` 的 CLI 參考文件（無介面節點主機）"
read_when:
  - 執行無介面節點主機時
  - 配對非 macOS 節點以使用 system.run 時
title: "node"
---

# `openclaw node`

執行一個**無介面節點主機 (headless node host)**，其會連線至 Gateway WebSocket 並在此機器上提供 `system.run` / `system.which` 功能。

## 為什麼要使用節點主機？

當您希望智慧代理在不需安裝完整 macOS 配套應用的情況下，於網路中的**其他機器上執行指令**時，請使用節點主機。

常見使用場景：

- 在遠端 Linux/Windows 機器上執行指令（構建伺服器、實驗室機器、NAS）。
- 將執行程式碼在 Gateway 上進行**沙箱隔離**，但將核准的執行作業委託給其他主機。
- 為自動化或 CI 節點提供輕量、無介面的執行目標。

執行作業仍受節點主機上的**執行核准 (exec approvals)** 和針對個別智慧代理的白名單保護，因此您可以確保指令存取權限是受限且明確的。

## 瀏覽器代理伺服器（零設定）

如果節點上未停用 `browser.enabled`，節點主機會自動宣佈瀏覽器代理伺服器。這讓智慧代理無需額外設定即可在該節點上使用瀏覽器自動化。

如果需要，請在節點上將其停用：

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

- `--host <host>`：Gateway WebSocket 主機（預設：`127.0.0.1`）
- `--port <port>`：Gateway WebSocket 連接埠（預設：`18789`）
- `--tls`：使用 TLS 連線至 Gateway
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`：覆蓋節點 ID（會清除配對權杖）
- `--display-name <name>`：覆蓋節點顯示名稱

## 服務（背景）

將無介面節點主機安裝為使用者服務。

```bash
openclaw node install --host <gateway-host> --port 18789
```

選項：

- `--host <host>`：Gateway WebSocket 主機（預設：`127.0.0.1`）
- `--port <port>`：Gateway WebSocket 連接埠（預設：`18789`）
- `--tls`：使用 TLS 連線至 Gateway
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`：覆蓋節點 ID（會清除配對權杖）
- `--display-name <name>`：覆蓋節點顯示名稱
- `--runtime <runtime>`：服務執行環境（`node` 或 `bun`）
- `--force`：如果已安裝則重新安裝/覆蓋

管理服務：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 執行前景節點主機（非服務）。

服務指令支援 `--json` 選項以提供機器可讀的輸出。

## 配對

首次連線會在 Gateway 上建立一個待處理的節點配對請求。請透過以下方式核准：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

節點主機會將其節點 ID、權杖 (token)、顯示名稱以及 Gateway 連線資訊儲存在 `~/.openclaw/node.json`。

## 執行核准 (Exec approvals)

`system.run` 受到本地執行核准的限制：

- `~/.openclaw/exec-approvals.json`
- [執行核准 (Exec approvals)](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（從 Gateway 進行編輯）
