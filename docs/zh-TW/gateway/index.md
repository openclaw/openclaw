---
summary: "Runbook for the Gateway service, lifecycle, and operations"
read_when:
  - Running or debugging the gateway process
title: Gateway Runbook
---

# Gateway runbook

請使用此頁面進行 Gateway 服務的第一天啟動和第二天操作。

<CardGroup cols={2}>
  <Card title="深入故障排除" icon="siren" href="/gateway/troubleshooting">
    以症狀為首的診斷，提供精確的指令階梯和日誌簽名。
  </Card>
  <Card title="設定" icon="sliders" href="/gateway/configuration">
    以任務為導向的設置指南 + 完整的設定參考。
  </Card>
  <Card title="秘密管理" icon="key-round" href="/gateway/secrets">
    SecretRef 合約、執行時快照行為，以及遷移/重新加載操作。
  </Card>
  <Card title="秘密計畫合約" icon="shield-check" href="/gateway/secrets-plan-contract">
    精確的 `secrets apply` 目標/路徑規則和僅參考的身份驗證設定行為。
  </Card>
</CardGroup>

## 5分鐘本地創業

<Steps>
  <Step title="啟動閘道">

```bash
openclaw gateway --port 18789
# debug/trace mirrored to stdio
openclaw gateway --port 18789 --verbose
# force-kill listener on selected port, then start
openclaw gateway --force
```

</Step>

<Step title="驗證服務健康狀態">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

Healthy baseline: `Runtime: running` 和 `RPC probe: ok`。

</Step>

<Step title="驗證頻道準備狀態">

```bash
openclaw channels status --probe
```

</Step>
</Steps>

<Note>
Gateway 設定重新加載會監視活動設定檔路徑（從設定檔/狀態預設值解析，或在設置時使用 `OPENCLAW_CONFIG_PATH`）。
預設模式為 `gateway.reload.mode="hybrid"`。
</Note>

## Runtime model

- 一個持續執行的過程，用於路由、控制平面和通道連接。
- 單一多路復用端口，用於：
  - WebSocket 控制/RPC
  - HTTP API（與 OpenAI 兼容、回應、工具調用）
  - 控制 UI 和鉤子
- 預設綁定模式：`loopback`。
- 預設需要身份驗證 (`gateway.auth.token` / `gateway.auth.password`，或 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### 端口和綁定優先順序

| 設定     | 解析順序                                                      |
| -------- | ------------------------------------------------------------- |
| 閘道埠   | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 綁定模式 | CLI/override → `gateway.bind` → `loopback`                    |

### 熱重載模式

| `gateway.reload.mode` | 行為                       |
| --------------------- | -------------------------- |
| `off`                 | 不重新載入設定             |
| `hot`                 | 僅應用熱安全變更           |
| `restart`             | 在需要重新載入的變更時重啟 |
| `hybrid` (預設)       | 安全時熱應用，必要時重啟   |

## Operator command set

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw secrets reload
openclaw logs --follow
openclaw doctor
```

## 遠端存取

首選：Tailscale/VPN。  
備用：SSH 隧道。

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

然後將用戶端連接到 `ws://127.0.0.1:18789` 本地。

<Warning>
如果已設定閘道身份驗證，用戶端仍必須發送身份驗證 (`token`/`password`)，即使是在 SSH 隧道中也是如此。
</Warning>

請參閱：[Remote Gateway](/gateway/remote)、[Authentication](/gateway/authentication)、[Tailscale](/gateway/tailscale)。

## 監控與服務生命週期

使用監督式執行以達到類似生產環境的可靠性。

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 標籤為 `ai.openclaw.gateway`（預設）或 `ai.openclaw.<profile>`（命名的設定檔）。`openclaw doctor` 會審核並修復服務設定的漂移。

</Tab>

<Tab title="Linux (systemd 使用者)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

要在登出後保持持久性，請啟用 lingering：

```bash
sudo loginctl enable-linger <user>
```

</Tab>

<Tab title="Linux (系統服務)">

使用系統單元來支援多使用者/持續執行的主機。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

</Tab>
</Tabs>

## 多個網關在同一主機上

大多數設置應該執行 **一個** Gateway。僅在需要嚴格隔離/冗餘的情況下（例如救援設定檔）使用多個。

[[BLOCK_1]]  
Checklist per instance:  
[[BLOCK_1]]

- Unique `gateway.port`
- Unique `OPENCLAW_CONFIG_PATH`
- Unique `OPENCLAW_STATE_DIR`
- Unique `agents.defaults.workspace`

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

請參閱：[多個閘道](/gateway/multiple-gateways)。

### Dev profile quick path

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

預設包括隔離的狀態/設定和基本閘道埠 `19001`。

## 協議快速參考（操作員視圖）

- 第一個用戶端框架必須是 `connect`。
- 閘道返回 `hello-ok` 快照 (`presence`, `health`, `stateVersion`, `uptimeMs`, 限制/政策)。
- 請求: `req(method, params)` → `res(ok/payload|error)`。
- 常見事件: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`。

Agent runs 是兩個階段的：

1. 立即接受的確認 (`status:"accepted"`)
2. 最終完成回應 (`status:"ok"|"error"`)，並在之間有串流的 `agent` 事件。

查看完整的協議文件：[Gateway Protocol](/gateway/protocol)。

## Operational checks

### Liveness

- 開啟 WS 並發送 `connect`。
- 預期收到 `hello-ok` 的回應，並包含快照。

### Readiness

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### Gap recovery

事件不會重播。在序列間隙時，請在繼續之前刷新狀態 (`health`, `system-presence`)。

## 常見失敗簽名

| 簽名                                                           | 可能的問題                        |
| -------------------------------------------------------------- | --------------------------------- |
| `refusing to bind gateway ... without auth`                    | 非迴圈回路綁定且未提供 token/密碼 |
| `another gateway instance is already listening` / `EADDRINUSE` | 埠衝突                            |
| `Gateway start blocked: set gateway.mode=local`                | 設定為遠端模式                    |
| `unauthorized` 在連接期間                                      | 用戶端與閘道之間的認證不匹配      |

對於完整的診斷流程，請使用 [Gateway Troubleshooting](/gateway/troubleshooting)。

## Safety guarantees

- 當 Gateway 無法使用時，Gateway 協議用戶端會快速失敗（沒有隱式的直接通道回退）。
- 無效/無法連接的第一幀會被拒絕並關閉。
- 優雅關閉在套接字關閉之前會發出 `shutdown` 事件。

---

[[BLOCK_1]]

- [故障排除](/gateway/troubleshooting)
- [背景程序](/gateway/background-process)
- [設定](/gateway/configuration)
- [健康狀態](/gateway/health)
- [診斷](/gateway/doctor)
- [身份驗證](/gateway/authentication)
