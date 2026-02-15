---
summary: "Gateway服務、生命週期與作業的運行手冊"
read_when:
  - 執行或偵錯 Gateway程序時
title: "Gateway運行手冊"
---

# Gateway運行手冊

本頁提供 Gateway服務的日後啟動與日常作業指引。

<CardGroup cols={2}>
  <Card title="深度疑難排解" icon="siren" href="/gateway/troubleshooting">
    以症狀為主的診斷，包含精確的命令梯次與日誌特徵。
  </Card>
  <Card title="設定" icon="sliders" href="/gateway/configuration">
    任務導向的設定指南 + 完整設定參考。
  </Card>
</CardGroup>

## 5 分鐘本地快速開始

<Steps>
  <Step title="啟動 Gateway">

```bash
openclaw gateway --port 18789
# 偵錯/追蹤鏡像到標準輸出
openclaw gateway --port 18789 --verbose
# 強制終止選定連接埠上的監聽器，然後啟動
openclaw gateway --force
```

  </Step>

  <Step title="驗證服務健康狀況">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

健康的基準線：`Runtime: running` 和 `RPC probe: ok`。

  </Step>

  <Step title="驗證頻道就緒狀態">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gateway設定重載會監控活動設定檔案路徑（從設定檔/狀態預設值或設定 `OPENCLAW_CONFIG_PATH` 時解析）。
預設模式為 `gateway.reload.mode="hybrid"`。
</Note>

## 運行模型

- 一個路由、控制平面與頻道連線的常駐程序。
- 單一多工連接埠用於：
  - WebSocket 控制/RPC
  - HTTP API (相容 OpenAI、回應、工具呼叫)
  - 控制使用者介面與掛鉤
- 預設綁定模式：`loopback`。
- 預設需要身份驗證（`gateway.auth.token` / `gateway.auth.password`，或 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）。

### 連接埠與綁定優先順序

| 設定       | 解析順序                                                  |
| ------------ | --------------------------------------------------------- |
| Gateway連接埠 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 綁定模式   | CLI/覆寫 → `gateway.bind` → `loopback`                    |

### 熱重載模式

| `gateway.reload.mode` | 行為                                       |
| --------------------- | ------------------------------------------ |
| `off`                 | 無設定重載                                 |
| `hot`                 | 僅套用熱安全變更                             |
| `restart`             | 重新載入所需變更時重新啟動                   |
| `hybrid` (預設)       | 安全時熱套用，需要時重新啟動                 |

## 操作員命令集

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw logs --follow
openclaw doctor
```

## 遠端存取

首選：Tailscale/VPN。
備用：SSH 通道。

```bash
ssh -N -L 18789:127.0.0.1:18789 user @host
```

然後將客戶端連接到本地的 `ws://127.0.0.1:18789`。

<Warning>
如果設定了 Gateway身份驗證，即使透過 SSH 通道，客戶端仍必須傳送身份驗證（`token`/`password`）。
</Warning>

請參閱：[遠端 Gateway](/gateway/remote)、[身份驗證](/gateway/authentication)、[Tailscale](/gateway/tailscale)。

## 監管與服務生命週期

使用受監管的運行以獲得類似生產環境的可靠性。

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 標籤為 `ai.openclaw.gateway` (預設) 或 `ai.openclaw.<profile>` (命名設定檔)。`openclaw doctor` 審核並修復服務設定漂移。

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

若要登出後仍保持持久性，請啟用 lingering：

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (系統服務)">

多使用者/常駐主機請使用系統單元。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 單一主機上的多個 Gateway

大多數設定應運行**一個** Gateway。
僅在需要嚴格隔離/冗餘時（例如救援設定檔）才使用多個。

每個實例的檢查清單：

- 唯一的 `gateway.port`
- 唯一的 `OPENCLAW_CONFIG_PATH`
- 唯一的 `OPENCLAW_STATE_DIR`
- 唯一的 `agents.defaults.workspace`

範例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

請參閱：[多個 Gateway](/gateway/multiple-gateways)。

### 開發設定檔快速路徑

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

預設包含隔離的狀態/設定與基礎 Gateway連接埠 `19001`。

## 協議快速參考（操作員視圖）

- 第一個客戶端幀必須是 `connect`。
- Gateway返回 `hello-ok` 快照（`presence`、`health`、`stateVersion`、`uptimeMs`、限制/策略）。
- 請求：`req(method, params)` → `res(ok/payload|error)`。
- 常見事件：`connect.challenge`、`agent`、`chat`、`presence`、`tick`、`health`、`heartbeat`、`shutdown`。

智慧代理執行分為兩個階段：

1. 立即接受確認（`status:"accepted"`）
2. 最終完成回應（`status:"ok"|"error"`），中間夾帶串流的 `agent` 事件。

請參閱完整協議文件：[Gateway協議](/gateway/protocol)。

## 操作檢查

### 存活度

- 開啟 WS 並發送 `connect`。
- 預期收到帶有快照的 `hello-ok` 回應。

### 就緒狀態

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 間隙復原

事件不會重播。在序列間隙時，請在繼續之前刷新狀態（`health`、`system-presence`）。

## 常見故障特徵

| 特徵                                                      | 可能的問題                             |
| --------------------------------------------------------- | ------------------------------------ |
| `refusing to bind gateway ... without auth`               | 未提供 token/密碼的非 local loopback 綁定 |
| `another gateway instance is already listening` / `EADDRINUSE` | 連接埠衝突                            |
| `Gateway start blocked: set gateway.mode=local`           | 設定為遠端模式                       |
| `unauthorized` during connect                             | 客戶端與 Gateway之間的身份驗證不符 |

如需完整的診斷梯次，請使用 [Gateway疑難排解](/gateway/troubleshooting)。

## 安全保證

- 當 Gateway不可用時，Gateway協議客戶端會快速失敗（無隱式直接頻道備援）。
- 無效/非連接的第一幀將被拒絕並關閉。
- 優雅關閉會在 socket 關閉前發出 `shutdown` 事件。

---

相關：

- [疑難排解](/gateway/troubleshooting)
- [背景程序](/gateway/background-process)
- [設定](/gateway/configuration)
- [健康狀況](/gateway/health)
- [診斷](/gateway/doctor)
- [身份驗證](/gateway/authentication)
