---
summary: "快速頻道層級疑難排解，提供各頻道故障特徵與修復方式"
read_when:
  - 頻道傳輸顯示已連接但回覆失敗
  - 您在深入供應商文件前需要頻道專屬檢查
title: "頻道疑難排解"
---

# 頻道疑難排解

當頻道已連接但行為異常時，請使用此頁面。

## 指令階梯

請先依序執行以下指令：

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
- 頻道探測顯示已連接/就緒

## WhatsApp

### WhatsApp 故障特徵

| 症狀                            | 最快檢查                                            | 修復方式                                                 |
| :------------------------------ | :-------------------------------------------------- | :------------------------------------------------------- |
| 已連接但無私訊回覆              | `openclaw pairing list whatsapp`                    | 核准寄件者或切換私訊政策/允許清單。                      |
| 群組訊息被忽略                  | 檢查設定中的 `requireMention` + 提及模式              | 提及機器人或放寬該群組的提及政策。                       |
| 隨機斷線/重新登入循環           | `openclaw channels status --probe` + 日誌           | 重新登入並驗證憑證目錄是否正常。                         |

完整疑難排解：[/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 故障特徵

| 症狀                            | 最快檢查                                        | 修復方式                                                 |
| :------------------------------ | :---------------------------------------------- | :------------------------------------------------------- |
| `/start` 但無可用回覆流程       | `openclaw pairing list telegram`                | 核准配對或變更私訊政策。                                 |
| 機器人上線但群組保持靜默        | 驗證提及要求與機器人隱私模式                      | 停用群組可見性的隱私模式或提及機器人。                   |
| 因網路錯誤導致傳送失敗          | 檢查日誌中的 Telegram API 呼叫失敗              | 修復 DNS/IPv6/代理路由至 `api.telegram.org`。            |

完整疑難排解：[/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 故障特徵

| 症狀                            | 最快檢查                                        | 修復方式                                                   |
| :------------------------------ | :---------------------------------------------- | :--------------------------------------------------------- |
| 機器人上線但無公會回覆          | `openclaw channels status --probe`              | 允許公會/頻道並驗證訊息內容意圖。                          |
| 群組訊息被忽略                  | 檢查日誌中的提及門檻丟棄                          | 提及機器人或設定公會/頻道 `requireMention: false`。      |
| 私訊回覆遺失                    | `openclaw pairing list discord`                 | 核准私訊配對或調整私訊政策。                               |

完整疑難排解：[/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 故障特徵

| 症狀                                | 最快檢查                                    | 修復方式                                                 |
| :---------------------------------- | :------------------------------------------ | :------------------------------------------------------- |
| Socket 模式已連接但無回應           | `openclaw channels status --probe`          | 驗證應用程式權杖 + 機器人權杖與所需範圍。                |
| 私訊被阻擋                          | `openclaw pairing list slack`               | 核准配對或放寬私訊政策。                                 |
| 頻道訊息被忽略                      | 檢查 `groupPolicy` 與頻道允許清單           | 允許該頻道或將政策切換至 `open`。                        |

完整疑難排解：[/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 與 BlueBubbles

### iMessage 與 BlueBubbles 故障特徵

| 症狀                            | 最快檢查                                                                | 修復方式                                                 |
| :------------------------------ | :---------------------------------------------------------------------- | :------------------------------------------------------- |
| 無入站事件                      | 驗證 webhook/伺服器可達性與應用程式權限                                 | 修復 webhook URL 或 BlueBubbles 伺服器狀態。             |
| 可傳送但 macOS 無法接收         | 檢查 macOS 訊息自動化的隱私權限                                         | 重新授予 TCC 權限並重新啟動頻道程序。                    |
| 私訊寄件者被阻擋                | `openclaw pairing list imessage` 或 `openclaw pairing list bluebubbles` | 核准配對或更新允許清單。                                 |

完整疑難排解：

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 故障特徵

| 症狀                            | 最快檢查                                        | 修復方式                                                   |
| :------------------------------ | :---------------------------------------------- | :--------------------------------------------------------- |
| 守護程式可達但機器人靜默        | `openclaw channels status --probe`              | 驗證 `signal-cli` 守護程式 URL/帳戶與接收模式。            |
| 私訊被阻擋                      | `openclaw pairing list signal`                  | 核准寄件者或調整私訊政策。                                 |
| 群組回覆未觸發                  | 檢查群組允許清單與提及模式                        | 新增寄件者/群組或放寬門檻。                                |

完整疑難排解：[/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix 故障特徵

| 症狀                            | 最快檢查                                        | 修復方式                                                   |
| :------------------------------ | :---------------------------------------------- | :--------------------------------------------------------- |
| 已登入但忽略聊天室訊息          | `openclaw channels status --probe`              | 檢查 `groupPolicy` 與聊天室允許清單。                      |
| 私訊未處理                      | `openclaw pairing list matrix`                  | 核准寄件者或調整私訊政策。                                 |
| 加密聊天室失敗                  | 驗證加密模組與加密設定                            | 啟用加密支援並重新加入/同步聊天室。                        |

完整疑難排解：[/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
