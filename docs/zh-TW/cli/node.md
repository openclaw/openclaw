---
summary: "「openclaw node」（無頭節點主機）的 CLI 參考文件"
read_when:
  - 執行無頭節點主機時
  - 為 system.run 配對非 macOS 的節點
title: "node"
x-i18n:
  source_path: cli/node.md
  source_hash: a8b1a57712663e22
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:26Z
---

# `openclaw node`

執行一個**無頭節點主機**，連線至 Gateway WebSocket，並在此機器上公開
`system.run` / `system.which`。

## 為什麼要使用節點主機？

當你希望代理程式在你的網路中**於其他機器上執行指令**，但不想在那些機器上安裝完整的 macOS 配套應用程式時，請使用節點主機。

常見使用情境：

- 在遠端 Linux／Windows 機器上執行指令（建置伺服器、實驗室機器、 NAS）。
- 在 Gateway 閘道器 上保持 exec **沙箱隔離**，但將已核准的執行委派給其他主機。
- 為自動化或 CI 節點提供輕量、無頭的執行目標。

執行仍然受到**exec 核准**與節點主機上每個代理程式的允許清單所保護，因此你可以讓指令存取維持在明確且受限的範圍內。

## 瀏覽器代理（零設定）

如果節點上未停用 `browser.enabled`，節點主機會自動公告一個瀏覽器代理。這可讓代理程式在該節點上使用瀏覽器自動化，而無需額外設定。

如有需要，可在節點上停用：

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
- `--tls`：對 Gateway 連線使用 TLS
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋（sha256）
- `--node-id <id>`：覆寫節點 id（會清除配對權杖）
- `--display-name <name>`：覆寫節點顯示名稱

## 服務（背景）

將無頭節點主機安裝為使用者服務。

```bash
openclaw node install --host <gateway-host> --port 18789
```

選項：

- `--host <host>`：Gateway WebSocket 主機（預設：`127.0.0.1`）
- `--port <port>`：Gateway WebSocket 連接埠（預設：`18789`）
- `--tls`：對 Gateway 連線使用 TLS
- `--tls-fingerprint <sha256>`：預期的 TLS 憑證指紋（sha256）
- `--node-id <id>`：覆寫節點 id（會清除配對權杖）
- `--display-name <name>`：覆寫節點顯示名稱
- `--runtime <runtime>`：服務執行環境（`node` 或 `bun`）
- `--force`：若已安裝則重新安裝／覆寫

管理服務：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

對於前景節點主機（非服務），請使用 `openclaw node run`。

服務指令接受 `--json` 以取得機器可讀的輸出。

## 配對

第一次連線會在 Gateway 上建立一個待處理的節點配對請求。
請透過以下方式核准：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

節點主機會將其節點 id、權杖、顯示名稱，以及 Gateway 連線資訊儲存在
`~/.openclaw/node.json` 中。

## Exec 核准

`system.run` 受本機 exec 核准所管控：

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（從 Gateway 編輯）
