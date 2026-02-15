---
summary: "診斷旗標用於目標性偵錯日誌"
read_when:
  - 您需要目標性偵錯日誌，而無需提高全域日誌記錄級別
  - 您需要擷取子系統特定的日誌以供支援
title: "診斷旗標"
---

# 診斷旗標

診斷旗標可讓您啟用目標性偵錯日誌，而無需在所有地方開啟詳細的日誌記錄。旗標是選擇加入的，除非子系統檢查它們，否則不會產生任何影響。

## 運作方式

- 旗標是字串（不區分大小寫）。
- 您可以在設定中或透過環境變數覆寫來啟用旗標。
- 支援萬用字元：
  - `telegram.*` 符合 `telegram.http`
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

更改旗標後，請重新啟動 Gateway。

## 環境變數覆寫（一次性）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

停用所有旗標：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 日誌儲存位置

旗標會將日誌發送到標準診斷日誌檔案中。預設情況下：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

如果您設定了 `logging.file`，請改用該路徑。日誌是 JSONL 格式（每行一個 JSON 物件）。遮蔽仍會根據 `logging.redactSensitive` 應用。

## 擷取日誌

選擇最新的日誌檔案：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

篩選 Telegram HTTP 診斷日誌：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

或在重現時追蹤日誌：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

對於遠端 Gateway，您也可以使用 `openclaw logs --follow` (請參閱 [/cli/logs](/cli/logs))。

## 注意事項

- 如果 `logging.level` 設定高於 `warn`，這些日誌可能會被抑制。預設的 `info` 是可以的。
- 旗標可以安全地保持啟用；它們只會影響特定子系統的日誌量。
- 使用 [/logging](/logging) 來更改日誌目的地、級別和遮蔽。
