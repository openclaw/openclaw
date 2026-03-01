# Sentinel 巡檢指令

每一輪執行以下 6 步。完成後 sleep 300 等下一輪。

---

## Step 1：讀取狀態

```bash
cat ~/clawd/sentinel/state.json
cat ~/clawd/sentinel/config.json
```

如果 `today_date` != 今天 → 重置 `alerts_today = 0`。

---

## Step 2：Bridge 健康檢查

```bash
curl -s -m 5 http://localhost:18790/health
curl -s -m 5 http://localhost:18795/health
```

任一 timeout → P0 `gateway_down`，跳到 Step 5 通知。

---

## Step 3：掃描所有群組

遍歷 config.json 的 groups，對每個群讀最近訊息：

```bash
curl -s "http://localhost:18790/messages?chat=<chat_id>&limit=15"
```

（bridge=andrew 的群用 18795）

對每個群的訊息，逐條掃描以下異常：

### 3a. 思考洩漏偵測（P0）

掃描無極/bot 發的訊息，如果包含 config.json `thought_leak_patterns` 中的任一模式：

- 記錄：哪個群、哪條訊息、什麼內容
- 嚴重度：P0

### 3b. Bot 不回應偵測（P0）

如果有人 @ 無極/bot，但之後 5 分鐘內沒有 bot 回覆：

- 記錄：哪個群、誰 @、多久沒回
- 嚴重度：P0
- 注意：排除非工作時間、排除 requireMention=false 的群

### 3c. 連續發多則偵測（P1）

如果 bot 在 2 分鐘內發了 3+ 條訊息：

- 記錄：哪個群、幾條、時間跨度
- 嚴重度：P1

### 3d. 重複訊息偵測（P0）

如果 bot 連續兩條訊息內容高度相似（>80% 重疊）：

- 記錄：哪個群、重複內容摘要
- 嚴重度：P0

### 3e. 自我評價偵測（P1）

掃描 bot 訊息包含 config.json `self_eval_patterns`：

- 嚴重度：P1

### 3f. 方案菜單偵測（P1）

掃描 bot 訊息包含 config.json `menu_patterns`：

- 嚴重度：P1

### 3g. Emoji 標題偵測（P2）

掃描 bot 訊息是否用 emoji 當段落標題（行首 emoji + 空格 + 大寫/粗體）：

- 嚴重度：P2

---

## Step 4：Workspace 一致性檢查（每 6 輪做一次）

```bash
# openclaw.json workspace 路徑
grep '"workspace"' ~/.openclaw/openclaw.json | grep -q 'clawd/workspace' || echo "DRIFT"

# 殭屍 workspace 目錄
[ -d ~/.openclaw/workspace ] && [ ! -L ~/.openclaw/workspace ] && echo "ZOMBIE_DIR"

# 殭屍 root md 檔案
ls ~/.openclaw/*.md 2>/dev/null && echo "ZOMBIE_MD"
```

任何異常 → P2 `workspace_drift`

---

## Step 5：處理異常

對每個發現的異常：

1. **去重** — 檢查 state.json `known_issues`，相同 group + type + 1 小時內 → 跳過
2. **記錄** — 寫入 `~/clawd/sentinel/memory/incidents/YYYY-MM-DD.md`
3. **通知** — P0/P1 通知 Cruz：

```bash
curl -s -X POST http://localhost:18790/send \
  -H 'Content-Type: application/json' \
  -d '{"chat_id": "448345880", "text": "..."}'
```

通知格式：

```
[Sentinel] P0 思考洩漏
群：BG666DB (-5140508587)
內容：「讓我檢查一下這個數據...」
時間：12:35
```

P2 不通知，只記錄。

4. **更新 known_issues** — 加入已通知的問題，附 timestamp

---

## Step 6：更新狀態 & 等待

更新 state.json：

```json
{
  "last_scan_at": "<ISO 時間>",
  "scan_count": "<+1>",
  "group_health": {
    "-5140508587": { "status": "ok", "last_bot_msg": "12:30", "issues": [] },
    ...
  },
  "alerts_today": "<累計>",
  "today_date": "<今天>"
}
```

清理 known_issues 中超過 24 小時的舊項目。

然後等待下一輪：

```bash
sleep 300
```

---

## 通知限流

- 同一個問題 1 小時內只通知一次
- 每天最多 20 則通知（避免轟炸 Cruz）
- alerts_today >= 20 → 只記錄不通知

---

## 完成承諾

輸出 `<promise>ALL_P0_FIXED</promise>` 當且僅當：

- 連續 3 輪掃描零 P0
- Bridge 健康
- 所有群正常運作
