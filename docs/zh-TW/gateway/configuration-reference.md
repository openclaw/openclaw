---
title: "設定參考指南"
description: "針對 ~/.openclaw/openclaw.json 的完整欄位參考指南"
---

# 設定參考指南

`~/.openclaw/openclaw.json` 中可用的每個欄位。如需以任務為導向的概觀，請參閱 [設定](/gateway/configuration)。

設定格式為 **JSON5**（允許註解和尾隨逗號）。所有欄位皆為選填 — 若省略，OpenClaw 會使用安全的預設值。

---

## 頻道 (Channels)

當該頻道的設定區段存在時，頻道會自動啟動（除非 `enabled: false`）。

### 私訊與群組存取

所有頻道皆支援私訊政策與
