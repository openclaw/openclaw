---
summary: "快速的頻道層級疑難排解，提供各頻道的失敗特徵與修復方式"
read_when:
  - 頻道傳輸顯示已連線，但回覆失敗
  - 在深入提供者文件之前，需要進行頻道專屬檢查
title: "頻道疑難排解"
---

# 頻道疑難排解

17. 當頻道已連線但行為不正確時，請使用此頁面。

## 命令階梯

請先依序執行以下項目：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

健康的基準狀態：

- `Runtime: running`
- `RPC probe: ok`
- 頻道探測顯示已連線／就緒

## WhatsApp

### WhatsApp 失敗特徵

| 症狀          | 最快檢查                                    | 修復                                             |
| ----------- | --------------------------------------- | ---------------------------------------------- |
| 已連線但沒有私訊回覆  | `openclaw pairing list whatsapp`        | 18. 核准傳送者，或切換私訊政策／允許清單。 |
| 群組訊息被忽略     | 檢查 `requireMention` + 設定中的提及模式          | 19. 提及機器人，或放寬該群組的提及政策。  |
| 隨機斷線／重新登入循環 | `openclaw channels status --probe` + 記錄 | 20. 重新登入並驗證憑證目錄是否正常。    |

完整疑難排解：[/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 失敗特徵

| 症狀                  | 最快檢查                             | 修復                                      |
| ------------------- | -------------------------------- | --------------------------------------- |
| `/start` 但沒有可用的回覆流程 | `openclaw pairing list telegram` | 21. 核准配對或變更私訊政策。 |
| 機器人在線但群組保持沉默        | 驗證提及需求與機器人隱私模式                   | 停用隱私模式以取得群組可見性，或提及機器人。                  |
| 傳送失敗並伴隨網路錯誤         | 檢查記錄中的 Telegram API 呼叫失敗         | 修復 DNS／IPv6／代理路由至 `api.telegram.org`。   |

完整疑難排解：[/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 失敗特徵

| 症狀                                       | 最快檢查                                         | 修復                                            |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 22. 機器人在線但沒有伺服器回覆 | `openclaw channels status --probe`           | 23. 允許伺服器／頻道並驗證訊息內容意圖。 |
| 群組訊息被忽略                                  | 24. 檢查日誌以確認提及門檻被丟棄的情況 | 提及機器人或設定伺服器／頻道 `requireMention: false`。       |
| 25. 私訊回覆遺失        | `openclaw pairing list discord`              | 26. 核准私訊配對或調整私訊政策。     |

完整疑難排解：[/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 失敗特徵

| 症狀                | 最快檢查                               | 修復                                                 |
| ----------------- | ---------------------------------- | -------------------------------------------------- |
| Socket 模式已連線但沒有回應 | `openclaw channels status --probe` | 27. 驗證應用程式權杖與機器人權杖，以及所需的範圍。 |
| 私訊被封鎖             | `openclaw pairing list slack`      | 28. 核准配對或放寬私訊政策。            |
| 頻道訊息被忽略           | 檢查 `groupPolicy` 與頻道允許清單           | 允許該頻道或將政策切換為 `open`。                               |

完整疑難排解：[/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 與 BlueBubbles

### iMessage 與 BlueBubbles 失敗特徵

| 症狀                | 最快檢查                                                                   | 修復                                  |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| 沒有入站事件            | 驗證 webhook／伺服器可達性與應用程式權限                                               | 修復 webhook URL 或 BlueBubbles 伺服器狀態。 |
| 可傳送但在 macOS 上無法接收 | 檢查 macOS 對「訊息」自動化的隱私權限                                                 | 重新授予 TCC 權限並重新啟動頻道程序。               |
| 私訊寄件者被封鎖          | `openclaw pairing list imessage` 或 `openclaw pairing list bluebubbles` | 核准配對或更新允許清單。                        |

完整疑難排解：

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 失敗特徵

| 症狀                                        | 最快檢查                               | 修復                                                            |
| ----------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| 29. 常駐程式可連線但機器人無回應 | `openclaw channels status --probe` | 30. 驗證 `signal-cli` 常駐程式的 URL／帳號與接收模式。 |
| 31. 私訊被封鎖          | `openclaw pairing list signal`     | 核准寄件者或調整私訊政策。                                                 |
| 群組回覆未觸發                                   | 檢查群組允許清單與提及模式                      | 新增寄件者／群組或放寬閘控。                                                |

完整疑難排解：[/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix 失敗特徵

| 症狀                               | 最快檢查                               | 修復                        |
| -------------------------------- | ---------------------------------- | ------------------------- |
| 已登入但忽略房間訊息                       | `openclaw channels status --probe` | 檢查 `groupPolicy` 與房間允許清單。 |
| 32. 私訊未處理 | `openclaw pairing list matrix`     | 核准寄件者或調整私訊政策。             |
| 加密房間失敗                           | 驗證加密模組與加密設定                        | 啟用加密支援並重新加入／同步房間。         |

完整疑難排解：[/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
