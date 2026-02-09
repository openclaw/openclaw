---
summary: "用於目標式除錯記錄的診斷旗標"
read_when:
  - You need targeted debug logs without raising global logging levels
  - 您需要擷取特定子系統的記錄以供支援
title: "診斷旗標"
---

# 診斷旗標

診斷旗標可讓您在不啟用全面冗長記錄的情況下，開啟目標式的除錯記錄。旗標為選擇性啟用，且只有在子系統檢查它們時才會生效。 Flags are opt-in and have no effect unless a subsystem checks them.

## How it works

- 旗標是字串（不區分大小寫）。
- You can enable flags in config or via an env override.
- Wildcards are supported:
  - `telegram.*` 會符合 `telegram.http`
  - `*` 會啟用所有旗標

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

變更旗標後請重新啟動 Gateway 閘道器。

## Env override (one-off)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

停用所有旗標：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 1. 日誌儲存位置

2. 旗標會將日誌輸出到標準診斷日誌檔。 3. 預設情況下：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

4. 如果你設定了 `logging.file`，則改用該路徑。 5. 日誌為 JSONL 格式（每行一個 JSON 物件）。 6. 仍會依據 `logging.redactSensitive` 套用遮蔽。

## 7. 擷取日誌

選擇最新的記錄檔：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

篩選 Telegram HTTP 診斷：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

8. 或在重現問題時即時追蹤：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

對於遠端 Gateway 閘道器，您也可以使用 `openclaw logs --follow`（請參閱 [/cli/logs](/cli/logs)）。

## 注意事項

- 若 `logging.level` 設定高於 `warn`，這些記錄可能會被抑制。預設的 `info` 即可。 9. 預設的 `info` 即可。
- 10. 這些旗標可以安全地保持啟用；它們只會影響特定子系統的日誌量。
- 使用 [/logging](/logging) 變更記錄目的地、等級與遮罩設定。
