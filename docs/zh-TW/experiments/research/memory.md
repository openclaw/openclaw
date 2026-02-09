---
summary: "研究筆記：Clawd 工作區的離線記憶系統（Markdown 作為事實來源 + 衍生索引）"
read_when:
  - 設計超越每日 Markdown 記錄的工作區記憶（~/.openclaw/workspace）
  - Deciding: 決定：獨立 CLI 還是深度整合 OpenClaw
  - 新增離線回憶 + 反思（保留／回憶／反思）
title: "工作區記憶研究"
---

# Workspace Memory v2（離線）：研究筆記

目標：Clawd 風格的工作區（`agents.defaults.workspace`，預設 `~/.openclaw/workspace`），其中「記憶」以每日一個 Markdown 檔案（`memory/YYYY-MM-DD.md`）儲存，並搭配一小組穩定檔案（例如 `memory.md`、`SOUL.md`）。

This doc proposes an **offline-first** memory architecture that keeps Markdown as the canonical, reviewable source of truth, but adds **structured recall** (search, entity summaries, confidence updates) via a derived index.

## 為什麼要改變？

目前的設定（每天一個檔案）非常適合：

- 「只追加」的日誌記錄
- human editing
- 以 git 為後盾的耐久性 + 可稽核性
- 低摩擦的捕捉方式（「就寫下來」）

It’s weak for:

- 高回憶率的檢索（「我們對 X 做了什麼決定？」、「上次嘗試 Y 是什麼時候？」）
- 以實體為中心的回答（「告訴我 Alice／The Castle／warelay」），而不必重讀許多檔案
- 意見／偏好的一致性（以及其變更時的證據）
- 時間限制（「2025 年 11 月期間什麼是真的？」）與衝突解決 and conflict resolution

## 設計目標

- **離線**：無需網路即可運作；可在筆電／Castle 上執行；無雲端相依。
- **可解釋**：檢索到的項目應可追溯（檔案 + 位置），並可與推論分離。
- **低儀式感**：每日記錄維持 Markdown，不需繁重的結構化結構。
- **漸進式**：v1 僅用 FTS 即有價值；語意／向量與圖結構為選用升級。
- **Agent-friendly**: makes “recall within token budgets” easy (return small bundles of facts).

## 北極星模型（Hindsight × Letta）

融合兩個部分：

1. **Letta／MemGPT 風格的控制迴圈**

- 維持一個小型「核心」永遠在上下文中（角色 + 關鍵使用者事實）
- everything else is out-of-context and retrieved via tools
- 記憶寫入為明確的工具呼叫（追加／取代／插入），持久化後於下一回合重新注入

2. **Hindsight 風格的記憶基底**

- separate what’s observed vs what’s believed vs what’s summarized
- 支援保留／回憶／反思
- confidence-bearing opinions that can evolve with evidence
- entity-aware retrieval + temporal queries (even without full knowledge graphs)

## 提議的架構（Markdown 作為事實來源 + 衍生索引）

### Canonical store (git-friendly)

保留 `~/.openclaw/workspace` 作為權威的人類可讀記憶。

Suggested workspace layout:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

注意事項：

- **Daily log stays daily log**. No need to turn it into JSON.
- `bank/` 檔案是 **精選的**，由反思工作產生，且仍可手動編輯。
- `memory.md` 維持「小而核心」：你希望 Clawd 每個工作階段都能看到的內容。

### 衍生儲存（機器回憶）

在工作區下新增一個衍生索引（不一定納入 git 追蹤）：

```
~/.openclaw/workspace/.memory/index.sqlite
```

Back it with:

- 用於事實 + 實體連結 + 意見中繼資料的 SQLite schema
- 用於詞彙回憶的 SQLite **FTS5**（快速、輕量、離線）
- 選用的語意回憶嵌入表（仍然離線）

索引始終 **可由 Markdown 重建**。

## 保留／回憶／反思（操作迴圈）

### 保留：將每日記錄正規化為「事實」

Hindsight 在此最重要的洞見：儲存 **敘事性、可自足的事實**，而不是微小片段。

對於 `memory/YYYY-MM-DD.md` 的實務規則：

- 在一天結束時（或期間），新增一個 `## Retain` 區段，包含 2–5 個條列，需具備：
  - narrative (cross-turn context preserved)
  - self-contained (standalone makes sense later)
  - 以類型 + 實體提及進行標記

範例：

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

最小化解析：

- 類型前綴：`W`（世界）、`B`（經驗／生平）、`O`（意見）、`S`（觀察／摘要；通常自動產生）
- 實體：`@Peter`、`@warelay` 等（slug 對應至 `bank/entities/*.md`）
- 意見信心：`O(c=0.0..1.0)`（選用）

如果你不希望作者去思考這些：反思工作可以從其餘記錄中推斷這些條列，但明確的 `## Retain` 區段是最容易提升品質的「槓桿」。

### 回憶：對衍生索引進行查詢

回憶應支援：

- **詞彙**：「尋找精確詞彙／名稱／指令」（FTS5）
- **實體**：「告訴我 X」（實體頁 + 與實體連結的事實）
- **時間**：「11 月 27 日左右發生了什麼」／「自上週以來」
- **意見**：「Peter 偏好什麼？」（附信心 + 證據） (with confidence + evidence)

Return format should be agent-friendly and cite sources:

- `kind`（`world|experience|opinion|observation`）
- `timestamp`（來源日期，或若存在則為擷取的時間範圍）
- `entities`（`["Peter","warelay"]`）
- `content`（敘事性事實）
- `source`（`memory/2025-11-27.md#L12` 等）

### 反思：產生穩定頁面 + 更新信念

反思是排程工作（每日或心跳 `ultrathink`），其內容包括：

- 從近期事實更新 `bank/entities/*.md`（實體摘要）
- 根據強化／矛盾更新 `bank/opinions.md` 的信心
- 視需要提議編輯 `memory.md`（「偏核心」的耐久事實）

Opinion evolution (simple, explainable):

- 每個意見包含：
  - 陳述
  - 信心 `c ∈ [0,1]`
  - last_updated
  - 證據連結（支持 + 矛盾的事實 ID）
- 當新事實到來時：
  - 以實體重疊 + 相似度找出候選意見（先用 FTS，之後再用嵌入）
  - 以小幅度更新信心；大幅跳動需要強烈矛盾 + 重複證據

## CLI 整合：獨立 vs 深度整合

建議：**深度整合於 OpenClaw**，但保留可分離的核心函式庫。

### 為什麼要整合進 OpenClaw？

- OpenClaw 已經知道：
  - 工作區路徑（`agents.defaults.workspace`）
  - 工作階段模型 + 心跳
  - 記錄 + 疑難排解模式
- 你會希望代理程式本身呼叫工具：
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Why still split a library?

- 讓記憶邏輯在沒有 Gateway 閘道器／執行環境下也可測試
- 可在其他情境重用（本地腳本、未來桌面應用等）

形態：
記憶工具預期是一個小型 CLI + 函式庫層，但目前僅屬探索性。

## 「S-Collide」／SuCo：何時使用（研究）

如果「S-Collide」指的是 **SuCo（Subspace Collision）**：這是一種 ANN 檢索方法，透過在子空間中使用學習／結構化的碰撞，來達成良好的回憶率／延遲取捨（論文：arXiv 2411.14754，2024）。

對於 `~/.openclaw/workspace` 的務實看法：

- **不要一開始就用** SuCo。
- 從 SQLite FTS +（選用）簡單嵌入開始；你會立刻獲得大多數 UX 收益。
- 只有在以下情況才考慮 SuCo／HNSW／ScaNN 類解法：
  - corpus is big (tens/hundreds of thousands of chunks)
  - 暴力的嵌入搜尋變得太慢
  - 回憶品質確實被詞彙搜尋明顯限制

離線友善的替代方案（由低到高複雜度）：

- SQLite FTS5 + 中繼資料過濾（零 ML）
- Embeddings + brute force (works surprisingly far if chunk count is low)
- HNSW 索引（常見、穩健；需要函式庫綁定）
- SuCo（研究等級；若有可嵌入的成熟實作則具吸引力）

Open question:

- 在你的機器（筆電 + 桌機）上，用於「個人助理記憶」的 **最佳** 離線嵌入模型是什麼？
  - 如果你已經有 Ollama：用本地模型做嵌入；否則在工具鏈中隨附一個小型嵌入模型。

## Smallest useful pilot

如果你想要一個最小、但仍然有用的版本：

- 新增 `bank/` 實體頁，以及每日記錄中的 `## Retain` 區段。
- 使用 SQLite FTS 進行可引用來源的回憶（路徑 + 行號）。
- Add embeddings only if recall quality or scale demands it.

## 參考資料

- Letta／MemGPT 概念：「核心記憶區塊」+「封存記憶」+ 由工具驅動的自我編輯記憶。
- Hindsight 技術報告：「保留／回憶／反思」、四網路記憶、敘事性事實擷取、意見信心演進。
- SuCo：arXiv 2411.14754（2024）：「Subspace Collision」近似最近鄰檢索。
