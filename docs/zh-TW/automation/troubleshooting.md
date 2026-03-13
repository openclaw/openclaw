---
summary: "自動化與排程故障排除"
read_when:
  - 工作未如期執行時
  - 遇到時區或傳遞錯誤時
  - 診斷心跳或 cron 行為時
title: "故障排除 (自動化)"
---

# 自動化故障排除 (心跳與 Cron)

本文件涵蓋了 Gateway 內建排程器 (Cron) 與心跳 (Heartbeat) 機制的常見問題。

有關 Gateway 整體的連線、資料庫或驗證錯誤，請參閱 [Gateway 故障排除](/gateway/troubleshooting)。

## 診斷指令

在嘗試進階修復前，請先執行以下指令以確認當前狀態：

```bash
# 檢查 Gateway 是否偵測到任何工作或心跳
openclaw status

# 列出所有已排定的 cron 工作
openclaw cron list

# 追蹤即時日誌以觀察排程器觸發
openclaw logs --follow
```

---

## 常見問題

### 1. 「沒有東西在執行」

如果心跳未觸發或 cron 工作似乎被忽略：

- **檢查是否已啟用**：確保配置中 `cron.enabled` 為 `true` (預設為 true)。若設定了 `OPENCLAW_SKIP_CRON=1` 環境變數，排程器將不會啟動。
- **檢查 Gateway 程序**：Cron 執行於 Gateway 內部。如果 Gateway 停止執行，工作就不會執行。
- **心跳延遲**：心跳並非精確的 cron 任務；它們會根據 `heartbeat.interval` (預設 5 分鐘) 執行。如果 Gateway 剛啟動，可能需要等待一個完整的週期。

### 2. 時區與排程偏差

如果您發現工作在錯誤的「掛鐘時間」執行：

- **主機時區**：OpenClaw 預設使用 Gateway 執行主機的本地時間。
- **配置檢查**：執行以下指令檢查時區設定：

```bash
openclaw config get agents.defaults.userTimezone || echo "未設定 agents.defaults.userTimezone"
openclaw cron list
openclaw logs --follow
```

快速規則：

- `Config path not found: agents.defaults.userTimezone` 表示該鍵未設定；心跳會退回到主機時區（或 `activeHours.timezone`，若有設定）。
- Cron 若無 `--tz` 參數，則使用 Gateway 主機時區。
- 心跳 `activeHours` 使用配置的時區解析（`user`, `local`, 或明確的 IANA 時區）。
- 對於 cron `at` 排程，不含時區的 ISO 時間戳記會被視為 UTC。

常見特徵：

- 在主機時區變更後，工作在錯誤的時間執行。
- 由於 `activeHours.timezone` 錯誤，心跳在您的白天時間總是被跳過。

相關資源：

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
