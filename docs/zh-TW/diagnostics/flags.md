---
summary: Diagnostics flags for targeted debug logs
read_when:
  - You need targeted debug logs without raising global logging levels
  - You need to capture subsystem-specific logs for support
title: Diagnostics Flags
---

# Diagnostics Flags

診斷標誌讓你可以啟用針對性的除錯日誌，而不必在所有地方開啟詳細日誌。這些標誌是選擇性的，除非子系統檢查它們，否則不會產生任何效果。

## 如何運作

- 標誌是字串（不區分大小寫）。
- 您可以在設定中啟用標誌或通過環境變數覆蓋。
- 支援通配符：
  - `telegram.*` 匹配 `telegram.http`
  - `*` 啟用所有標誌

## 透過設定啟用

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

[[BLOCK_1]]

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

在更改標誌後，請重新啟動網關。

## Env override (one-off)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

[[BLOCK_1]]  
Disable all flags:  
[[BLOCK_1]]

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 日誌存放位置

Flags 會將日誌輸出到標準診斷日誌檔案中。預設情況下：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

如果你設定了 `logging.file`，請使用該路徑。日誌為 JSONL 格式（每行一個 JSON 物件）。根據 `logging.redactSensitive`，仍然適用遮蔽。

## Extract logs

選擇最新的日誌檔案：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

[[BLOCK_1]]  
過濾 Telegram HTTP 診斷：  
[[BLOCK_1]]

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

[[BLOCK_1]]

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

對於遠端閘道，您也可以使用 `openclaw logs --follow` (請參見 [/cli/logs](/cli/logs))。

## Notes

- 如果 `logging.level` 設定高於 `warn`，這些日誌可能會被抑制。預設的 `info` 是可以的。
- 標誌可以安全地保持啟用；它們僅影響特定子系統的日誌量。
- 使用 [/logging](/logging) 來更改日誌目的地、級別和隱私處理。
