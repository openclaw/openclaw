---
summary: "SOUL Evil 勾點（在 purge 視窗期間或隨機機率下，將 SOUL.md 與 SOUL_EVIL.md 交換）"
read_when:
  - 您想要啟用或調整 SOUL Evil 勾點
  - 您需要 purge 視窗或隨機機率的人格切換
title: "SOUL Evil 勾點"
---

# SOUL Evil 勾點

SOUL Evil 勾點會在 purge 視窗期間或以隨機機率，將**注入的** `SOUL.md` 內容替換為 `SOUL_EVIL.md`。它**不會**修改磁碟上的檔案。 It does **not** modify files on disk.

## How It Works

當 `agent:bootstrap` 執行時，勾點可以在系統提示組裝之前，於記憶體中替換 `SOUL.md` 內容。若 `SOUL_EVIL.md` 缺失或為空，OpenClaw 會記錄警告並保留一般的 `SOUL.md`。 If `SOUL_EVIL.md` is missing or empty,
OpenClaw logs a warning and keeps the normal `SOUL.md`.

子代理程式的執行**不會**在其啟動檔案中包含 `SOUL.md`，因此此勾點對子代理程式沒有影響。

## 啟用

```bash
openclaw hooks enable soul-evil
```

接著設定設定值：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

在代理程式工作區根目錄（與 `SOUL.md` 同層）建立 `SOUL_EVIL.md`。

## 選項

- `file`（字串）：替代的 SOUL 檔名（預設：`SOUL_EVIL.md`）
- `chance`（數字 0–1）：每次執行使用 `SOUL_EVIL.md` 的隨機機率
- `purge.at`（HH:mm）：每日 purge 開始時間（24 小時制）
- `purge.duration`（持續時間）：視窗長度（例如：`30s`、`10m`、`1h`）

**優先順序：** purge 視窗優先於隨機機率。

**時區：** 若有設定則使用 `agents.defaults.userTimezone`；否則使用主機時區。

## 注意事項

- 不會在磁碟上寫入或修改任何檔案。
- 若 `SOUL.md` 不在啟動清單中，勾點不會執行任何動作。

## See Also

- [Hooks](/automation/hooks)
