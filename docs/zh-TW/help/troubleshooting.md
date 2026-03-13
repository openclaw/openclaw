---
summary: Symptom first troubleshooting hub for OpenClaw
read_when:
  - OpenClaw is not working and you need the fastest path to a fix
  - You want a triage flow before diving into deep runbooks
title: Troubleshooting
---

# 疑難排解

如果你只有 2 分鐘，請使用此頁作為初步篩選入口。

## 前 60 秒

依序執行以下步驟：

```bash
openclaw status
openclaw status --all
openclaw gateway probe
openclaw gateway status
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

良好輸出範例（一行）：

- `openclaw status` → 顯示已設定的頻道且無明顯授權錯誤。
- `openclaw status --all` → 完整報告已生成且可分享。
- `openclaw gateway probe` → 預期的閘道目標可連線。
- `openclaw gateway status` → `Runtime: running` 與 `RPC probe: ok`。
- `openclaw doctor` → 無阻擋的設定或服務錯誤。
- `openclaw channels status --probe` → 頻道報告 `connected` 或 `ready`。
- `openclaw logs --follow` → 活動穩定，無重複致命錯誤。

## Anthropic 長上下文 429 錯誤

如果你看到：
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`，
請前往 [/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context)。

## 插件安裝失敗，缺少 openclaw 擴充功能

如果安裝失敗並顯示 `package.json missing openclaw.extensions`，表示插件套件
使用了 OpenClaw 不再接受的舊版格式。

在插件套件中修正方法：

1. 將 `openclaw.extensions` 新增至 `package.json`。
2. 將條目指向已編譯的執行時檔案（通常是 `./dist/index.js`）。
3. 重新發佈插件並再次執行 `openclaw plugins install <npm-spec>`。

範例：

```json
{
  "name": "@openclaw/my-plugin",
  "version": "1.2.3",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

Reference: [/tools/plugin#distribution-npm](/tools/plugin#distribution-npm)

## 決策樹

mermaid
flowchart TD
A[OpenClaw 無法運作] --> B{最先壞掉的是什麼}
B --> C[沒有回應]
B --> D[儀表板或控制介面無法連線]
B --> E[Gateway 無法啟動或服務未執行]
B --> F[頻道已連線但訊息無法流通]
B --> G[Cron 或心跳未觸發或未送達]
B --> H[節點已配對但相機畫布畫面執行失敗]
B --> I[瀏覽器工具失敗]

C --> C1[/沒有回應區段/]
D --> D1[/控制介面區段/]
E --> E1[/Gateway 區段/]
F --> F1[/頻道流通區段/]
G --> G1[/自動化區段/]
H --> H1[/節點工具區段/]
I --> I1[/瀏覽器區段/]

<AccordionGroup>
  <Accordion title="沒有回應">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw channels status --probe
    openclaw pairing list --channel <channel> [--account <id>]
    openclaw logs --follow
    ```

良好的輸出範例：

- `Runtime: running`
  - `RPC probe: ok`
  - 你的頻道在 `channels status --probe` 顯示已連線/準備就緒
  - 傳送者看起來已核准（或 DM 政策為開放/允許清單）

常見日誌特徵：

- `drop guild message (mention required` → 表示在 Discord 中提及閘道阻擋了訊息。
  - `pairing request` → 傳送者未核准，正在等待 DM 配對核准。
  - `blocked` / `allowlist` 在頻道日誌中 → 傳送者、房間或群組被過濾。

深入頁面：

- [/gateway/troubleshooting#no-replies](/gateway/troubleshooting#no-replies)
  - [/channels/troubleshooting](/channels/troubleshooting)
  - [/channels/pairing](/channels/pairing)

</Accordion>

<Accordion title="儀表板或控制介面無法連線">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw logs --follow
    openclaw doctor
    openclaw channels status --probe
    ```

良好的輸出範例：

- `Dashboard: http://...` 顯示於 `openclaw gateway status`
  - `RPC probe: ok`
  - 日誌中無認證迴圈

常見日誌特徵：

- `device identity required` → HTTP/非安全環境無法完成裝置驗證。
  - `AUTH_TOKEN_MISMATCH` 帶有重試提示 (`canRetryWithDeviceToken=true`) → 可能會自動進行一次受信任裝置 token 的重試。
  - 之後重複出現 `unauthorized` → token/密碼錯誤、驗證模式不符，或配對裝置 token 已過期。
  - `gateway connect failed:` → UI 指向錯誤的 URL/埠號或無法連接閘道。

深入頁面：

- [/gateway/troubleshooting#dashboard-control-ui-connectivity](/gateway/troubleshooting#dashboard-control-ui-connectivity)
  - [/web/control-ui](/web/control-ui)
  - [/gateway/authentication](/gateway/authentication)

</Accordion>

<Accordion title="閘道無法啟動或服務已安裝但未執行">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw logs --follow
    openclaw doctor
    openclaw channels status --probe
    ```

良好輸出範例：

- `Service: ... (loaded)`
  - `Runtime: running`
  - `RPC probe: ok`

常見日誌特徵：

- `Gateway start blocked: set gateway.mode=local` → 閘道模式未設定或為遠端模式。
  - `refusing to bind gateway ... without auth` → 非迴圈綁定且無 token/密碼。
  - `another gateway instance is already listening` 或 `EADDRINUSE` → 埠號已被佔用。

深入頁面：

- [/gateway/troubleshooting#gateway-service-not-running](/gateway/troubleshooting#gateway-service-not-running)
  - [/gateway/background-process](/gateway/background-process)
  - [/gateway/configuration](/gateway/configuration)

</Accordion>

<Accordion title="頻道已連線但訊息無法流通">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw logs --follow
    openclaw doctor
    openclaw channels status --probe
    ```

良好輸出範例：

- 通道傳輸已連接。
  - 配對/允許清單檢查通過。
  - 必要時偵測到提及。

常見日誌特徵：

- `mention required` → 群組提及閘道阻擋處理。
  - `pairing` / `pending` → 私訊發送者尚未獲批准。
  - `not_in_channel`, `missing_scope`, `Forbidden`, `401/403` → 通道權限 token 問題。

深入頁面：

- [/gateway/troubleshooting#channel-connected-messages-not-flowing](/gateway/troubleshooting#channel-connected-messages-not-flowing)
  - [/channels/troubleshooting](/channels/troubleshooting)

</Accordion>

<Accordion title="排程或心跳未觸發或未送達">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw cron status
    openclaw cron list
    openclaw cron runs --id <jobId> --limit 20
    openclaw logs --follow
    ```

良好輸出範例：

- `cron.status` 顯示已啟用且有下一次喚醒時間。
  - `cron runs` 顯示近期 `ok` 條目。
  - 心跳已啟用且未超出活動時間。

常見日誌特徵：

- `cron: scheduler disabled; jobs will not run automatically` → 排程被停用。
  - `heartbeat skipped` 搭配 `reason=quiet-hours` → 超出設定的活動時間。
  - `requests-in-flight` → 主要流程忙碌；心跳喚醒被延後。
  - `unknown accountId` → 心跳送達目標帳號不存在。

深入頁面：

- [/gateway/troubleshooting#cron-and-heartbeat-delivery](/gateway/troubleshooting#cron-and-heartbeat-delivery)
  - [/automation/troubleshooting](/automation/troubleshooting)
  - [/gateway/heartbeat](/gateway/heartbeat)

</Accordion>

<Accordion title="節點已配對但工具無法執行相機畫布畫面">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw nodes status
    openclaw nodes describe --node <idOrNameOrIp>
    openclaw logs --follow
    ```

- 節點顯示為已連線並配對於角色 `node`。
  - 你所呼叫的指令具備相應的能力。
  - 工具的權限狀態已被授予。

常見日誌特徵：

- `NODE_BACKGROUND_UNAVAILABLE` → 將節點應用程式帶到前景。
  - `*_PERMISSION_REQUIRED` → 作業系統權限被拒絕或缺失。
  - `SYSTEM_RUN_DENIED: approval required` → 執行批准尚在等待中。
  - `SYSTEM_RUN_DENIED: allowlist miss` → 指令不在執行允許清單中。

深入頁面：

- [/gateway/troubleshooting#node-paired-tool-fails](/gateway/troubleshooting#node-paired-tool-fails)
  - [/nodes/troubleshooting](/nodes/troubleshooting)
  - [/tools/exec-approvals](/tools/exec-approvals)

</Accordion>

<Accordion title="瀏覽器工具失敗">
    ```bash
    openclaw status
    openclaw gateway status
    openclaw browser status
    openclaw logs --follow
    openclaw doctor
    ```

良好的輸出範例：

- 瀏覽器狀態顯示 `running: true` 及所選瀏覽器/設定檔。
  - `openclaw` 設定檔啟動或 `chrome` 中繼有附加的分頁。

常見日誌特徵：

- `Failed to start Chrome CDP on port` → 本地瀏覽器啟動失敗。
  - `browser.executablePath not found` → 設定的執行檔路徑錯誤。
  - `Chrome extension relay is running, but no tab is connected` → 擴充功能未附加。
  - `Browser attachOnly is enabled ... not reachable` → 僅附加設定檔沒有活躍的 CDP 目標。

深入頁面：

- [/gateway/troubleshooting#browser-tool-fails](/gateway/troubleshooting#browser-tool-fails)
  - [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
  - [/tools/browser-wsl2-windows-remote-cdp-troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)
  - [/tools/chrome-extension](/tools/chrome-extension)

</Accordion>
</AccordionGroup>
