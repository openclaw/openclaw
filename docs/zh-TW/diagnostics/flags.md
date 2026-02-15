---
summary: "針對特定除錯紀錄的診斷旗標"
read_when:
  - 您需要在不提高全域記錄等級的情況下獲取特定的除錯紀錄
  - 您需要擷取子系統特定的紀錄以進行支援
title: "診斷旗標"
---

# 診斷旗標

診斷旗標讓您能夠啟用特定目標的除錯紀錄，而無需開啟全域的詳細記錄。旗標是選擇性啟用的（opt-in），除非子系統檢查它們，否則不會產生任何影響。

## 運作方式

- 旗標是字串（不區分大小寫）。
- 您可以在設定中或透過環境變數覆寫來啟用旗標。
- 支援萬用字元：
  - `telegram.*` 匹配 `telegram.http`
  - `*` 啟用所有旗標

## 透過設定啟用

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

多個旗標：

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

更改旗標後請重新啟動 Gateway。

## 環境變數覆寫（一次性）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

停用所有旗標：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 紀錄儲存位置

旗標會將紀錄輸出到標準診斷記錄檔。預設路徑為：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

如果您設定了 `logging.file`，請改用該路徑。紀錄格式為 JSONL（每行一個 JSON 物件）。基於 `logging.redactSensitive` 的遮蔽規則仍然適用。

## 擷取紀錄

挑選最新的記錄檔：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

篩選 Telegram HTTP 診斷資訊：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

或在重現問題時使用 tail 監控：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

對於遠端 Gateway，您也可以使用 `openclaw logs --follow`（參見 [/cli/logs](/cli/logs)）。

## 注意事項

- 如果 `logging.level` 設定高於 `warn`，這些紀錄可能會被隱藏。預設的 `info` 等級即可正常運作。
- 保持旗標啟用是安全的；它們只會影響特定子系統的記錄量。
- 使用 [/logging](/logging) 來更改記錄目的地、等級和遮蔽設定。
