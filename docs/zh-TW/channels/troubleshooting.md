---
summary: "快速的頻道層級疑難排解，包含各頻道的故障特徵與修復方法"
read_when:
  - 頻道傳輸顯示已連線，但回覆失敗時
  - 在深入查閱供應商文件前，需要進行頻道特定檢查時
title: "頻道疑難排解"
---

# 頻道疑難排解

當頻道已連線但行為異常時，請參閱此頁面。

## 指令階梯

請依序執行以下指令：

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
- 頻道探測顯示已連線/就緒

## WhatsApp

### WhatsApp 故障特徵

| 症狀                  | 最快檢查方法                              | 修復方法                               |
| --------------------- | ----------------------------------------- | -------------------------------------- |
| 已連線但沒有私訊回覆  | `openclaw pairing list whatsapp`          | 核准傳送者或切換私訊政策/白名單。      |
| 群組訊息被忽略        | 檢查設定中的 `requireMention` + 標記模式  | 標記智慧代理，或放寬該群組的標記政策。 |
| 隨機斷線/重複登入迴圈 | `openclaw channels status --probe` + 記錄 | 重新登入並確認憑證目錄狀態正常。       |

完整疑難排解：[/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 故障特徵

| 症狀                               | 最快檢查方法                           | 修復方法                                                 |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| 執行 `/start` 但沒有可用的回覆流程 | `openclaw pairing list telegram`       | 核准配對或變更私訊政策。                                 |
| 機器人上線但群組保持沉默           | 驗證標記需求與機器人隱私模式           | 停用隱私模式以獲得群組可見性，或標記智慧代理。           |
| 傳送失敗並出現網路錯誤             | 檢查記錄中的 Telegram API 呼叫失敗資訊 | 修正前往 `api.telegram.org` 的 DNS/IPv6/代理伺服器路由。 |

完整疑難排解：[/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 故障特徵

| 症狀                     | 最快檢查方法                       | 修復方法                                                      |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| 機器人上線但伺服器無回覆 | `openclaw channels status --probe` | 允許伺服器/頻道並驗證訊息內容權限（intent）。                 |
| 群組訊息被忽略           | 檢查記錄中的標記限制丟棄情況       | 標記智慧代理或將伺服器/頻道的 `requireMention` 設為 `false`。 |
| 遺失私訊回覆             | `openclaw pairing list discord`    | 核准私訊配對或調整私訊政策。                                  |

完整疑難排解：[/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 故障特徵

| 症狀                      | 最快檢查方法                       | 修復方法                                             |
| ------------------------- | ---------------------------------- | ---------------------------------------------------- |
| Socket 模式已連線但無回應 | `openclaw channels status --probe` | 驗證 App 權杖 + Bot 權杖及所需的權限範圍（scopes）。 |
| 私訊被封鎖                | `openclaw pairing list slack`      | 核准配對或放寬私訊政策。                             |
| 頻道訊息被忽略            | 檢查 `groupPolicy` 與頻道白名單    | 允許該頻道或將政策切換為 `open`。                    |

完整疑難排解：[/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 與 BlueBubbles

### iMessage 與 BlueBub
