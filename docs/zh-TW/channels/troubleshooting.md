---
summary: >-
  Fast channel level troubleshooting with per channel failure signatures and
  fixes
read_when:
  - Channel transport says connected but replies fail
  - You need channel specific checks before deep provider docs
title: Channel Troubleshooting
---

# Channel 故障排除

當頻道連接但行為不正確時，請使用此頁面。

## Command ladder

[[BLOCK_1]]

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

健康基準：

- `Runtime: running`
- `RPC probe: ok`
- 通道探測顯示已連接/準備就緒

## WhatsApp

### WhatsApp 失敗簽名

| 症狀                  | 最快速的檢查                              | 修正                                |
| --------------------- | ----------------------------------------- | ----------------------------------- |
| 已連接但沒有 DM 回覆  | `openclaw pairing list whatsapp`          | 批准發送者或切換 DM 政策/允許清單。 |
| 群組訊息被忽略        | 檢查 `requireMention` + 設定中的提及模式  | 提及機器人或放寬該群組的提及政策。  |
| 隨機斷線/重新登入循環 | `openclaw channels status --probe` + 日誌 | 重新登入並確認憑證目錄是否正常。    |

完整故障排除：[/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 失敗簽名

| 症狀                           | 最快檢查                                 | 修正                                                              |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| `/start` 但沒有可用的回覆流程  | `openclaw pairing list telegram`         | 批准配對或更改 DM 政策。                                          |
| 機器人在線但群組保持沉默       | 驗證提及要求和機器人隱私模式             | 禁用隱私模式以便群組可見性或提及機器人。                          |
| 發送失敗並出現網路錯誤         | 檢查 Telegram API 呼叫失敗的日誌         | 修正 DNS/IPv6/代理路由至 `api.telegram.org`。                     |
| `setMyCommands` 在啟動時被拒絕 | 檢查 `BOT_COMMANDS_TOO_MUCH` 的日誌      | 減少插件/技能/自訂 Telegram 命令或禁用原生選單。                  |
| 升級後被允許清單阻擋           | `openclaw security audit` 和設定允許清單 | 執行 `openclaw doctor --fix` 或用數字發送者 ID 替換 `@username`。 |

完整故障排除: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 錯誤簽名

| 症狀                     | 最快速檢查                         | 修正                                                |
| ------------------------ | ---------------------------------- | --------------------------------------------------- |
| 機器人在線但沒有公會回覆 | `openclaw channels status --probe` | 允許公會/頻道並驗證訊息內容意圖。                   |
| 群組訊息被忽略           | 檢查日誌以尋找提及閘道掉落         | 提及機器人或設定公會/頻道 `requireMention: false`。 |
| 私訊回覆缺失             | `openclaw pairing list discord`    | 批准私訊配對或調整私訊政策。                        |

完整故障排除: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 失敗簽名

| 症狀                      | 最快檢查                           | 修正                                             |
| ------------------------- | ---------------------------------- | ------------------------------------------------ |
| Socket 模式已連接但無回應 | `openclaw channels status --probe` | 驗證應用程式 token + 機器人 token 及所需的範圍。 |
| 私訊被封鎖                | `openclaw pairing list slack`      | 批准配對或放寬私訊政策。                         |
| 頻道訊息被忽略            | 檢查 `groupPolicy` 和頻道允許清單  | 允許該頻道或將政策切換至 `open`。                |

完整故障排除: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 和 BlueBubbles

### iMessage 和 BlueBubbles 失敗簽名

| 症狀                          | 最快速的檢查                                                            | 修正                                         |
| ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 沒有進來的事件                | 驗證 webhook/伺服器可達性和應用程式權限                                 | 修正 webhook URL 或 BlueBubbles 伺服器狀態。 |
| 可以發送但在 macOS 上無法接收 | 檢查 macOS 的 Messages 自動化隱私權限                                   | 重新授予 TCC 權限並重新啟動通道進程。        |
| DM 發送者被封鎖               | `openclaw pairing list imessage` 或 `openclaw pairing list bluebubbles` | 批准配對或更新允許清單。                     |

[[BLOCK_1]]

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### 信號失敗簽名

| 症狀                    | 最快速的檢查                       | 修正                                             |
| ----------------------- | ---------------------------------- | ------------------------------------------------ |
| Daemon 可達但機器人靜默 | `openclaw channels status --probe` | 驗證 `signal-cli` daemon 的 URL/帳號和接收模式。 |
| DM 被阻擋               | `openclaw pairing list signal`     | 批准發送者或調整 DM 政策。                       |
| 群組回覆未觸發          | 檢查群組允許清單和提及模式         | 添加發送者/群組或放寬限制。                      |

完整的故障排除: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### 矩陣失敗簽名

| 症狀                 | 最快檢查                           | 修正                                |
| -------------------- | ---------------------------------- | ----------------------------------- |
| 已登入但忽略房間訊息 | `openclaw channels status --probe` | 檢查 `groupPolicy` 和房間允許清單。 |
| 私訊無法處理         | `openclaw pairing list matrix`     | 批准發送者或調整私訊政策。          |
| 加密房間失敗         | 驗證加密模組和加密設定             | 啟用加密支援並重新加入/同步房間。   |

完整故障排除: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
