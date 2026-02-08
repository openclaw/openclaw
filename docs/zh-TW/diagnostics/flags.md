---
summary: "用於目標式除錯記錄的診斷旗標"
read_when:
  - 您需要目標式的除錯記錄，而不提高全域記錄等級
  - 您需要擷取特定子系統的記錄以供支援
title: "診斷旗標"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:55Z
---

# 診斷旗標

診斷旗標可讓您在不啟用全面冗長記錄的情況下，開啟目標式的除錯記錄。旗標為選擇性啟用，且只有在子系統檢查它們時才會生效。

## 運作方式

- 旗標是字串（不區分大小寫）。
- 您可以在設定中啟用旗標，或透過環境變數覆寫。
- 支援萬用字元：
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

## 環境變數覆寫（一次性）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

停用所有旗標：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 記錄輸出位置

旗標會將記錄輸出到標準的診斷記錄檔。預設為：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

若您設定 `logging.file`，則會改用該路徑。記錄格式為 JSONL（每行一個 JSON 物件）。遮罩仍會依據 `logging.redactSensitive` 套用。

## 擷取記錄

選擇最新的記錄檔：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

篩選 Telegram HTTP 診斷：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

或在重現問題時即時追蹤：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

對於遠端 Gateway 閘道器，您也可以使用 `openclaw logs --follow`（請參閱 [/cli/logs](/cli/logs)）。

## 注意事項

- 若 `logging.level` 設定高於 `warn`，這些記錄可能會被抑制。預設的 `info` 即可。
- 旗標可安全地長時間啟用；它們只會影響特定子系統的記錄量。
- 使用 [/logging](/logging) 變更記錄目的地、等級與遮罩設定。
