---
summary: "`openclaw node` 的 CLI 參考 (無頭節點主機)"
read_when:
  - 執行無頭節點主機時
  - 為 system.run 配對非 macOS 節點時
title: "node"
---

# `openclaw node`

執行一個**無頭節點主機**，它連接到 Gateway WebSocket 並在這台機器上公開 `system.run` / `system.which`。

## 為何使用節點主機？

當您希望智慧代理在您的網路中**其他機器上執行命令**，而無需在那些機器上安裝完整的 macOS 配套應用時，請使用節點主機。

常見用例：

- 在遠端 Linux/Windows 設備（建置伺服器、實驗室機器、NAS）上執行命令。
- 將執行保持在 Gateway 上**沙箱隔離**，但將經批准的執行委派給其他主機。
- 為自動化或 CI 節點提供輕量級、無頭的執行目標。

執行仍受節點主機上**執行批准**和每個智慧代理允許清單的保護，因此您可以保持命令存取範圍明確且顯式。

## 瀏覽器代理 (零設定)

如果節點上未停用 `browser.enabled`，節點主機將自動公告瀏覽器代理。這使得智慧代理可以在該節點上使用瀏覽器自動化，而無需額外設定。

如果需要，請在節點上停用它：

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 執行 (前景)

```bash
openclaw node run --host <gateway-host> --port 18789
```

選項：

- `--host <host>`: Gateway WebSocket 主機 (預設: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 埠 (預設: `18789`)
- `--tls`: 使用 TLS 進行 Gateway 連線
- `--tls-fingerprint <sha256>`: 預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`: 覆寫節點 ID (清除配對權杖)
- `--display-name <name>`: 覆寫節點顯示名稱

## 服務 (背景)

將無頭節點主機安裝為使用者服務。

```bash
openclaw node install --host <gateway-host> --port 18789
```

選項：

- `--host <host>`: Gateway WebSocket 主機 (預設: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 埠 (預設: `18789`)
- `--tls`: 使用 TLS 進行 Gateway 連線
- `--tls-fingerprint <sha256>`: 預期的 TLS 憑證指紋 (sha256)
- `--node-id <id>`: 覆寫節點 ID (清除配對權杖)
- `--display-name <name>`: 覆寫節點顯示名稱
- `--runtime <runtime>`: 服務執行環境 (`node` 或 `bun`)
- `--force`: 如果已安裝，則重新安裝/覆寫

管理服務：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 執行前景節點主機（無服務）。

服務命令接受 `--json` 以產生機器可讀的輸出。

## 配對

首次連線會在 Gateway 上建立一個待處理的節點配對請求。
透過以下方式批准：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

節點主機將其節點 ID、權杖、顯示名稱和 Gateway 連線資訊儲存在 `~/.openclaw/node.json`。

## 執行批准

`system.run` 受本地執行批准的限制：

- `~/.openclaw/exec-approvals.json`
- [執行批准](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (從 Gateway 編輯)
