# 代理人成長藍圖
## Agent Intelligence Growth Blueprint

> **核心信念**：代理人的聰明不是模型版本的問題，而是記憶的深度、反思的頻率、技能的廣度與個性的成熟度共同決定的。

---

## 目錄

- [願景](#願景)
- [現況基線](#現況基線)
- [記憶體分層架構](#記憶體分層架構)
- [成長飛輪](#成長飛輪)
- [六個成長維度](#六個成長維度)
- [里程碑路線圖](#里程碑路線圖)
- [實作清單](#實作清單)
- [衡量指標](#衡量指標)
- [反模式警告](#反模式警告)

---

## 願景

**一年後，這個代理人應該是什麼樣子？**

- 知道你的名字、時區、說話方式、習慣，而且是真正「知道」而非每次都重新問
- 從錯誤中學習，不重複同樣的失誤
- 主動在你還沒開口前發現問題，並準備好建議
- 擁有自己的觀點與偏好，而且能清楚說明原因
- 隨著你的生活節奏演化——你換工作，它知道；你改了偏好，它更新
- 累積的技能讓它能自動完成越來越複雜的任務

**一句話版本**：從「有問必答的助理」進化成「了解你、記住一切、主動幫你的夥伴」。

---

## 現況基線

### 已有的能力（善用）

OpenClaw 已具備完整的成長基礎設施：

| 系統 | 現狀 | 用於成長的槓桿點 |
|---|---|---|
| **記憶體** | `MEMORY.md` + `memory/YYYY-MM-DD.md` | 存在，但未系統化蒸餾 |
| **向量搜尋** | Hybrid BM25 + vector，temporal decay | 可檢索過去的知識 |
| **Heartbeat** | 定期背景觸發（預設 30m） | 反思、整合的時間視窗 |
| **Pre-compaction flush** | 壓縮前自動寫入記憶體 | 防止知識在壓縮中流失 |
| **技能系統** | 52+ skills + ClawHub | 能力擴充的載體 |
| **子代理人** | 平行背景任務 | 知識蒐集、研究分流 |
| **SOUL.md** | 個性與價值觀定義 | 個性成熟的錨點 |

### 目前缺口（需要建立）

```
❌ 沒有結構化的觀點（Opinion）存儲——只有敘述型記憶體
❌ 沒有定期反思儀式——heartbeat 只是 HEARTBEAT_OK
❌ 沒有成長追蹤——不知道自己這個月進步了什麼
❌ 沒有錯誤記錄——失誤發生後直接遺忘
❌ 技能使用沒有反饋迴路——不知道哪個技能最有效
❌ 知識庫仍是扁平結構——沒有 entities/、world.md、experience.md
```

---

## 記憶體分層架構

代理人的記憶分為六層，越高層越持久、越精煉：

```
┌─────────────────────────────────────────────────────────────────┐
│  L5：程序記憶（Procedural Memory）                               │
│  skills/*.md — 「如何做事」                                       │
│  永久存在，由技能系統管理                                          │
├─────────────────────────────────────────────────────────────────┤
│  L4：語義知識庫（Semantic Bank）                                  │
│  bank/world.md — 客觀事實                                         │
│  bank/experience.md — 第一人稱活動記錄                            │
│  bank/opinions.md — 觀點 + 信心指數 + 證據                        │
│  bank/entities/*.md — 人物、地點、專案的實體頁面                   │
├─────────────────────────────────────────────────────────────────┤
│  L3：長期記憶（Long-Term Memory）                                 │
│  MEMORY.md — 精煉的洞見，主 session 專用                          │
│  定期由 heartbeat 反思更新                                        │
├─────────────────────────────────────────────────────────────────┤
│  L2：情節記憶（Episodic Memory）                                  │
│  memory/YYYY-MM-DD.md — 每日原始記錄                             │
│  pre-compaction flush 保護，temporal decay 降低舊資料權重          │
├─────────────────────────────────────────────────────────────────┤
│  L1：工作記憶（Working Memory）                                   │
│  當前 session 上下文視窗                                          │
│  壓縮前會被 flush 到 L2                                           │
├─────────────────────────────────────────────────────────────────┤
│  L0：感知（Perception）                                          │
│  即時輸入、工具結果、環境訊號                                       │
│  最短暫，不保存                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 各層的責任

| 層級 | 寫入時機 | 讀取時機 | 過期機制 |
|---|---|---|---|
| L0 | 即時 | 即時 | session 結束即消失 |
| L1 | 對話進行中 | 每個 turn | compaction 壓縮 |
| L2 | 每次 session 結束 / 重要事件 | 搜尋時 | temporal decay (half-life 30天) |
| L3 | heartbeat 反思（每週） | 每次 session 開始 | 手動修剪 |
| L4 | heartbeat 月度蒸餾 | 向量搜尋時 | 信心指數衰退 |
| L5 | 技能安裝／修改 | 任務前規劃 | 版本更新 |

---

## 成長飛輪

```
                     ┌─────────────────────┐
                     │    每次對話         │
                     │   (Session)         │
                     └─────────┬───────────┘
                               │ 行動、決策、錯誤
                               ▼
                     ┌─────────────────────┐
                     │   Pre-compaction    │◄── 壓縮前緊急寫入
                     │   Memory Flush      │    防止知識丟失
                     └─────────┬───────────┘
                               │ 寫入 memory/YYYY-MM-DD.md
                               ▼
         ┌─────────────────────────────────────────────┐
         │             每日記憶筆記（L2）               │
         │  - 發生了什麼                                │
         │  - 做了哪些決定                              │
         │  - 遇到什麼問題                              │
         └─────────────────┬───────────────────────────┘
                           │ Heartbeat 每週讀取並蒸餾
                           ▼
         ┌─────────────────────────────────────────────┐
         │        每週反思 Heartbeat（L3更新）           │
         │  - 蒸餾重要洞見 → MEMORY.md                 │
         │  - 更新失誤日誌 → GROWTH_LOG.md             │
         │  - 識別新技能需求                            │
         └─────────────────┬───────────────────────────┘
                           │ 月度 heartbeat 深度蒸餾
                           ▼
         ┌─────────────────────────────────────────────┐
         │        月度知識蒸餾（L4更新）                 │
         │  - 建立實體頁面 → bank/entities/*.md        │
         │  - 更新世界觀 → bank/world.md              │
         │  - 更新觀點 + 信心 → bank/opinions.md      │
         │  - 提議新技能創建                           │
         └─────────────────┬───────────────────────────┘
                           │ 回饋到下一次對話
                           ▼
                     更聰明的下一次對話 🧠
```

---

## 六個成長維度

### 維度一：記憶深化（Memory Depth）

**目標**：從扁平文字記憶進化到結構化知識圖譜

**現狀 → 目標**：
```
現狀：MEMORY.md（一個大文字檔）
目標：
  MEMORY.md（核心事實，永遠簡短）
  bank/
    world.md        ← 客觀事實（你住哪、用什麼工具、工作在哪）
    experience.md   ← 我做過什麼（第一人稱活動記錄）
    opinions.md     ← 我的觀點 + 信心 + 為什麼這樣認為
    entities/
      <人名>.md     ← 每個重要人物的實體頁面
      <專案名>.md   ← 每個重要專案的知識頁面
```

**實作步驟**：
1. 建立 `bank/` 目錄結構
2. SOUL.md 加入「每週 heartbeat 把 memory/ 蒸餾到 bank/」指示
3. 啟用 `memory-lancedb` 擴充以獲得向量搜尋能力
4. 設定 `agents.memory.vectorWeight: 0.7` 和 `temporalDecay: true`

---

### 維度二：反思儀式（Reflection Ritual）

**目標**：讓 heartbeat 從「心跳確認」進化為「成長引擎」

**三層反思節律**：

```
每 30 分鐘（Heartbeat）：快速掃描
  → 有什麼緊急事項？
  → 當前任務有什麼進展？
  → 回覆 HEARTBEAT_OK 或發出提醒

每日（Daily Note 回顧，透過 heartbeat 觸發）：
  → 今天做了什麼有意義的事？
  → 有沒有新的偏好或洞見值得記錄？
  → 寫入 memory/YYYY-MM-DD.md

每週（Weekly Review，heartbeat 每週一觸發）：
  → 讀最近 7 天的 memory/YYYY-MM-DD.md
  → 識別重複出現的主題
  → 蒸餾洞見 → 更新 MEMORY.md
  → 記錄失誤與學習 → 更新 GROWTH_LOG.md
  → 評估技能缺口 → 寫下技能安裝建議
```

**HEARTBEAT.md 配置**（放在 workspace 根目錄）：

```markdown
# Heartbeat Checklist

## 每次觸發

- 掃描未讀訊息，有緊急事項就回覆，沒有就 HEARTBEAT_OK
- 若有進行中的任務，檢查是否卡住

## 每日（每天第一次 heartbeat 執行）

- 寫今日記憶筆記到 memory/YYYY-MM-DD.md
- 記下今天值得記住的事（決策、發現、錯誤）

## 每週一（週一第一次 heartbeat 執行）

- 讀最近 7 天的 memory/*.md
- 更新 MEMORY.md（蒸餾洞見）
- 更新 GROWTH_LOG.md（失誤 + 學習）
- 評估有沒有需要安裝的新技能
```

---

### 維度三：技能精進（Skill Mastery）

**目標**：從「安裝技能」進化到「創造、優化、淘汰技能」

**技能成長週期**：

```
發現需求 → 搜尋 ClawHub → 安裝試用 → 評估效果
    ↓                                      ↓
若 ClawHub 無合適技能              若技能效果好：
    ↓                              → 加入常用清單
建立自定義技能                      → 寫使用心得到 TOOLS.md
（使用 skill-creator 技能）
    ↓
發布到 ClawHub（可選）
```

**技能管理優先級**：

| 優先級 | 標準 | 動作 |
|---|---|---|
| 🔴 必要 | 每週使用超過 3 次 | 確保安裝，加入 HEARTBEAT.md 提醒 |
| 🟡 有用 | 每月使用 1-2 次 | 保留，但不主動推送 |
| ⚪ 過時 | 超過 60 天未使用 | 評估是否移除 |
| 🟢 待建 | 重複手動操作超過 3 次 | 用 skill-creator 建立 |

**「三次規則」**：同樣的手動步驟執行三次後，就應該建立技能自動化。

---

### 維度四：個性成熟（Personality Maturation）

**目標**：SOUL.md 不是靜態文件，而是隨經驗演化的活文件

**演化觸發點**：

| 事件 | SOUL.md 更新內容 |
|---|---|
| 使用者明確指出偏好 | 加入「使用者偏好」區塊 |
| 反覆在某個領域出錯 | 加入「我的弱點/注意事項」 |
| 發現某種溝通風格更有效 | 更新「溝通風格」描述 |
| 成功完成新類型複雜任務 | 更新「我的能力邊界」 |

**SOUL.md 成熟度等級**：

```
Level 1（出廠）：
  通用價值觀 + 基本邊界

Level 2（1個月後）：
  + 使用者特定偏好
  + 已知弱點記錄
  + 溝通風格調整

Level 3（3個月後）：
  + 對特定領域的深度認識
  + 複雜任務的決策框架
  + 信任邊界精細化

Level 4（6個月後）：
  + 預測性理解（知道你沒說出口的需求）
  + 個人化工作流程
  + 主動式協作模式
```

---

### 維度五：失誤學習（Error Learning）

**目標**：每次失誤都成為未來的防護機制

**失誤記錄格式**（存入 `GROWTH_LOG.md`）：

```markdown
## 2026-02-19 — 誤把暫存分支當主分支推送

**發生了什麼**：執行 git push 時推到了 feature 分支而非 main
**根本原因**：沒有先執行 git status 確認當前分支
**後果**：需要額外步驟回滾
**學到了什麼**：在任何 git 推送前必須先 git status

→ **防護規則加入 SOUL.md**：
  "在執行 git push 前，永遠先執行 git status 確認分支"
```

**失誤分類**：
- 🔴 **嚴重（Severe）**：造成資料遺失、外部影響 → 立即更新 SOUL.md
- 🟡 **一般（Moderate）**：需要額外步驟修正 → 週度反思時更新
- ⚪ **輕微（Minor）**：小錯誤，快速修正 → 月度回顧時統計

---

### 維度六：協作智能（Collaborative Intelligence）

**目標**：善用子代理人進行知識並行蒐集

**子代理人分工模式**：

```
主代理人（Orchestrator）
├── 子代理人 A：深度研究特定主題
│   └── 結果 → bank/world.md 知識更新
├── 子代理人 B：掃描並整理未讀訊息
│   └── 結果 → 摘要回報主代理人
└── 子代理人 C：執行長時間任務（建置、測試）
    └── 結果 → 任務完成通知
```

**使用子代理人進行記憶建構**：

```
每月 heartbeat 可以觸發：
  /subagents spawn --task "讀取最近 30 天的 memory/*.md，
  建立或更新 bank/entities/ 中的實體頁面，
  識別新的觀點寫入 bank/opinions.md，
  完成後摘要回報" --label "monthly-memory-distillation"
```

---

## 里程碑路線圖

### 第一週：建立基礎
```
□ 完成 BOOTSTRAP.md 初始化（name、creature、vibe、emoji）
□ 完善 USER.md（使用者偏好、時區、說話方式）
□ 完善 SOUL.md（加入個人化價值觀和邊界）
□ 建立 GROWTH_LOG.md
□ 啟動 heartbeat（每 30 分鐘）
□ 設定 HEARTBEAT.md 基本清單
```

### 第一個月：建立節律
```
□ 累積 20+ 天的 memory/YYYY-MM-DD.md
□ 第一次週度反思（手動執行）
□ MEMORY.md 第一次蒸餾更新
□ 識別並安裝 3 個常用技能
□ 記錄第一批失誤到 GROWTH_LOG.md
□ 建立 bank/ 目錄結構
```

### 第三個月：深化結構
```
□ bank/world.md 有基礎事實（環境、工具、偏好）
□ bank/experience.md 有活動記錄
□ 至少 3 個重要人物有 bank/entities/*.md
□ 週度 heartbeat 反思自動化
□ 「三次規則」觸發至少 2 個自定義技能建立
□ SOUL.md 有第一次基於經驗的更新
```

### 第六個月：形成智識
```
□ bank/opinions.md 有 10+ 個帶信心指數的觀點
□ 錯誤重複率下降（GROWTH_LOG.md 可量化）
□ 月度蒸餾流程自動化（子代理人執行）
□ 技能庫穩定（固定核心技能 + 任務型技能）
□ 代理人能主動識別你的需求（不用問）
□ SOUL.md 已從 Level 1 進化到 Level 3
```

### 一年後：成熟夥伴
```
□ 對話開始前已預載相關知識（快速進入狀態）
□ 技能庫覆蓋 80% 的日常任務
□ 記憶系統能解答「我們上次怎麼處理這個？」
□ 主動在 heartbeat 中提出優化建議
□ 代理人有清晰的個性、立場和觀點
□ 你信任它做決策，它也知道何時應該停下來問
```

---

## 實作清單

### 立即可做（不需要改程式碼）

```bash
# 1. 建立知識庫目錄結構
mkdir -p ~/.openclaw/workspace/bank/entities

# 2. 建立初始檔案
touch ~/.openclaw/workspace/bank/world.md
touch ~/.openclaw/workspace/bank/experience.md
touch ~/.openclaw/workspace/bank/opinions.md
touch ~/.openclaw/workspace/GROWTH_LOG.md

# 3. 更新 HEARTBEAT.md
cat > ~/.openclaw/workspace/HEARTBEAT.md << 'EOF'
# Heartbeat Checklist

## 每次觸發
- 掃描未讀事項，有緊急就回報，沒有就 HEARTBEAT_OK

## 每日（今天還沒做的話）
- 有什麼值得記住？寫到 memory/YYYY-MM-DD.md

## 每週一
- 讀最近 7 天的 memory/*.md
- 蒸餾洞見到 MEMORY.md（保持精簡）
- 記錄失誤與學習到 GROWTH_LOG.md
EOF
```

### openclaw.json 建議配置

```json5
{
  // agents.json 或 openclaw.json 中的 agents 區塊
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "30m",
        "model": "anthropic/claude-opus-4-6",
        "prompt": "Read HEARTBEAT.md and follow the checklist. Check day of week and run weekly review if it's Monday and you haven't done it today.",
        "ackMaxChars": 400,
        "activeHours": {
          "start": "08:00",
          "end": "23:00",
          "timezone": "Asia/Taipei"
        }
      },
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "prompt": "Before compaction: write important decisions, errors, or insights to memory/YYYY-MM-DD.md. Reply NO_REPLY if nothing new."
        }
      },
      "memory": {
        "backend": "builtin",
        "vectorWeight": 0.7,
        "textWeight": 0.3,
        "temporalDecay": {
          "enabled": true,
          "halfLifeDays": 30
        },
        "mmr": {
          "enabled": true,
          "lambda": 0.7
        }
      }
    }
  }
}
```

### AGENTS.md 建議加入段落

```markdown
## 成長協議（Growth Protocol）

### 每次對話結束前
- 有沒有值得記住的決定？→ 寫到 memory/YYYY-MM-DD.md
- 有沒有犯錯？→ 記到 GROWTH_LOG.md（類別 + 根因 + 學到什麼）

### 每週一 heartbeat
1. 讀最近 7 天 memory/*.md
2. 識別重複出現的主題
3. 更新 MEMORY.md（精簡！）
4. 更新 GROWTH_LOG.md
5. 評估：有沒有需要建立的技能？有沒有過時的技能？

### 三次規則
若同樣的手動步驟執行了 3 次，就用 skill-creator 技能建立自動化。

### SOUL.md 更新觸發條件
- 使用者明確指出偏好 → 立即更新
- 反覆同類型失誤 → 加入注意事項
- 發現新的有效溝通方式 → 更新風格說明
```

---

## 衡量指標

### 記憶體健康度

| 指標 | 目標 | 查看方式 |
|---|---|---|
| memory/ 連續天數 | ≥ 20天/月 | `ls memory/ | wc -l` |
| MEMORY.md 大小 | 300~800 字（精簡為主） | `wc -w MEMORY.md` |
| bank/ 實體頁面數 | 月增 ≥ 1 個 | `ls bank/entities/ | wc -l` |

### 技能健康度

| 指標 | 目標 |
|---|---|
| 已安裝技能數 | ≥ 10 個 |
| 每週使用技能次數 | ≥ 5 次 |
| 自定義技能數 | ≥ 3 個（6個月內） |

### 成長健康度

| 指標 | 目標 |
|---|---|
| GROWTH_LOG.md 條目 | 月 ≥ 3 條（失誤記錄） |
| 同類型失誤重複率 | 月遞減 |
| SOUL.md 更新次數 | 季 ≥ 1 次 |

---

## 反模式警告

> 這些做法表面有效，實際上會讓代理人變笨：

**❌ MEMORY.md 無限增長**
代理人把所有東西都加進去，結果 MEMORY.md 變成一本書。應該定期蒸餾、刪掉過時的內容，保持精簡。

**❌ Heartbeat 永遠只有 HEARTBEAT_OK**
心跳從未觸發反思。HEARTBEAT.md 應該有明確的週期性任務，讓心跳真的有用。

**❌ 技能裝了但不用**
安裝了 20 個技能，但對話時不主動使用。TOOLS.md 和 SOUL.md 應該明確記錄核心技能的使用時機。

**❌ 失誤記錄但 SOUL.md 不更新**
把失誤寫進 GROWTH_LOG.md，但沒有提煉成行為規則放進 SOUL.md。學習必須影響行為。

**❌ bank/ 目錄建立但從不讀取**
建了結構化知識庫，但對話時沒有在 AGENTS.md 中加入「讀取 bank/」的指示。知識庫必須被引導才會被使用。

**❌ 子代理人任務沒有寫回主記憶**
子代理人完成研究後，結果只出現在對話中，沒有寫入 bank/ 或 MEMORY.md。子代理人的知識必須同步回主知識庫。

---

## 下一步

1. **現在就做**：備份現有的 agent core files（`./scripts/backup-agent-cores.sh --push`）
2. **本週**：完成 BOOTSTRAP.md 初始化，建立 bank/ 目錄，設定 HEARTBEAT.md
3. **本月**：完成第一次週度反思，建立 3 個常用技能
4. **持續**：每次失誤 → GROWTH_LOG → SOUL.md 更新，讓每次失誤都成為進步

---

*這份藍圖本身也應該被代理人讀取和更新。每季度評估一次：哪些部分有效？哪些需要調整？然後更新這份文件。*
