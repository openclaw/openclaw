---
summary: >-
  Research notes: offline memory system for Clawd workspaces (Markdown
  source-of-truth + derived index)
read_when:
  - >-
    Designing workspace memory (~/.openclaw/workspace) beyond daily Markdown
    logs
  - Deciding: standalone CLI vs deep OpenClaw integration
  - Adding offline recall + reflection (retain/recall/reflect)
title: Workspace Memory Research
---

# Workspace Memory v2 (offline): 研究筆記

目標：Clawd 風格的工作區 (`agents.defaults.workspace`，預設 `~/.openclaw/workspace`)，其中「記憶」以每天一個 Markdown 檔案的形式儲存 (`memory/YYYY-MM-DD.md`)，加上一小組穩定的檔案（例如 `memory.md`、`SOUL.md`）。

本文件提出了一種 **離線優先** 的記憶體架構，將 Markdown 作為權威的、可審核的真實來源，但透過衍生索引增加 **結構化回憶**（搜尋、實體摘要、信心更新）。

## 為什麼要改變？

目前的設置（每天一個檔案）非常適合：

- “僅附加”日誌記錄
- 人工編輯
- 基於 Git 的耐久性 + 可審計性
- 低摩擦捕捉（“只需寫下來”）

它對於：

- 高召回率檢索（“我們對 X 的決定是什麼？”、“上次我們嘗試 Y 的結果是什麼？”）
- 以實體為中心的答案（“告訴我關於 Alice / The Castle / warelay 的資訊”）而不需要重讀許多檔案
- 意見/偏好穩定性（以及變更時的證據）
- 時間限制（“在 2025 年 11 月時，什麼是正確的？”）和衝突解決

## 設計目標

- **離線**: 無需網路即可運作；可以在筆記型電腦/城堡上執行；不依賴雲端。
- **可解釋**: 檢索的專案應可歸因（檔案 + 位置）並且可與推論分開。
- **低儀式**: 每日記錄保持為 Markdown，無需繁重的架構工作。
- **增量式**: v1 僅使用 FTS 即可實用；語意/向量和圖形為可選升級。
- **友善於代理**: 使「在 token 預算內回憶」變得簡單（返回小包的事實）。

## North star model (Hindsight × Letta)

[[BLOCK_1]]  
兩個要融合的部分：  
[[BLOCK_2]]

1. **Letta/MemGPT 風格控制迴圈**

- 始終保持一個小的「核心」在上下文中（角色 + 主要用戶事實）
- 其他所有內容都是脫離上下文的，並通過工具檢索
- 記憶寫入是明確的工具調用（附加/替換/插入），持久化後在下一回合重新注入

2. **事後諸葛亮式記憶基底**

- 分開觀察到的事物、相信的事物與總結的內容
- 支援保留/回憶/反思
- 隨著證據演變的有信心的意見
- 實體感知的檢索 + 時間查詢（即使沒有完整的知識圖譜）

## 提議的架構 (Markdown 來源真相 + 派生索引)

### Canonical store (git-friendly)

保持 `~/.openclaw/workspace` 作為標準的人類可讀記憶。

建議的工作區佈局：

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

[[BLOCK_1]]

- **每日記錄仍然是每日記錄**。不需要將其轉換為 JSON。
- `bank/` 檔案是 **精心策劃** 的，由反思工作產生，仍然可以手動編輯。
- `memory.md` 保持「小型 + 核心」：你希望 Clawd 在每次會話中看到的內容。

### 派生商店（機器回憶）

在工作區下新增一個衍生索引（不一定需要被 git 追蹤）：

```
~/.openclaw/workspace/.memory/index.sqlite
```

[[BLOCK_1]]

- SQLite 架構用於事實 + 實體連結 + 意見元資料
- SQLite **FTS5** 用於詞彙回憶（快速、小型、離線）
- 可選的嵌入表用於語義回憶（仍然是離線）

索引始終可以**從 Markdown 重建**。

## 保留 / 回憶 / 反思 (操作循環)

### Retain: 將每日日誌標準化為「事實」

Hindsight 的關鍵見解在於：儲存 **敘事性、自成一體的事實**，而不是微小的片段。

實用規則 `memory/YYYY-MM-DD.md`:

- 在一天結束時（或期間），新增一個 `## Retain` 區段，包含 2–5 個要點，這些要點需符合以下條件：
  - 敘述性（跨回合上下文保持一致）
  - 自成一體（獨立存在時仍然有意義）
  - 標記類型 + 實體提及

[[BLOCK_1]]

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

[[BLOCK_1]]  
最小解析：  
[[BLOCK_1]]

- 類型前綴: `W` (世界), `B` (經驗/傳記), `O` (意見), `S` (觀察/摘要; 通常為生成)
- 實體: `@Peter`, `@warelay`, 等等 (標識對應 `bank/entities/*.md`)
- 意見信心: `O(c=0.0..1.0)` 可選

如果你不希望作者去思考這個問題：反射工作可以從其餘的日誌中推斷這些要點，但擁有一個明確的 `## Retain` 區段是最簡單的「品質杠桿」。

### Recall: 查詢衍生索引

Recall 應該支援：

- **lexical**: “尋找精確的術語 / 名稱 / 指令” (FTS5)
- **entity**: “告訴我關於 X 的資訊” (實體頁面 + 實體相關事實)
- **temporal**: “11 月 27 日前後發生了什麼？” / “自上週以來”
- **opinion**: “彼得偏好什麼？” (附帶信心 + 證據)

[[BLOCK_1]]

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (來源日期，或如果存在則為提取的時間範圍)
- `entities` (`["Peter","warelay"]`)
- `content` (敘述事實)
- `source` (`memory/2025-11-27.md#L12` 等)

### Reflect: 產生穩定的頁面 + 更新信念

Reflection 是一個排程工作（每日或心跳 `ultrathink`），其功能為：

- 更新 `bank/entities/*.md` 來自最近的事實（實體摘要）
- 根據強化/矛盾更新 `bank/opinions.md` 的信心
- 可選地對 `memory.md` 提出編輯建議（“核心”耐用事實）

[[BLOCK_1]]  
意見演變（簡單、可解釋）：  
[[BLOCK_1]]

- 每個意見包含：
  - 陳述
  - 信心 `c ∈ [0,1]`
  - 最後更新時間
  - 證據連結（支援和反駁的事實 ID）
- 當新事實到達時：
  - 通過實體重疊和相似性尋找候選意見（先使用 FTS，然後使用嵌入）
  - 透過小的變化更新信心；大的變化需要強烈的反駁和重複的證據

## CLI 整合：獨立整合 vs 深度整合

建議：**在 OpenClaw 中進行深度整合**，但保持可分離的核心函式庫。

### 為什麼要整合到 OpenClaw？

- OpenClaw 已經知道：
  - 工作區路徑 (`agents.defaults.workspace`)
  - 會話模型 + 心跳
  - 日誌記錄 + 故障排除模式
- 你希望代理本身來調用工具：
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 為什麼仍然要將庫拆分？

- 保持記憶邏輯可測試，無需網關/執行時
- 可從其他上下文重用（本地腳本、未來桌面應用程式等）

Shape:
這個記憶體工具旨在成為一個小型的 CLI + 函式庫層，但這僅僅是探索性質。

## “S-Collide” / SuCo: 何時使用它（研究）

如果「S-Collide」指的是 **SuCo (Subspace Collision)**：這是一種人工神經網路檢索方法，旨在通過在子空間中使用學習的/結構化的碰撞來達成強大的回憶/延遲權衡（論文：arXiv 2411.14754，2024）。

Pragmatic take for `~/.openclaw/workspace`:

- **不要以** SuCo 開始。
- 先從 SQLite FTS + （可選）簡單的嵌入開始；這樣你會立即獲得大部分的使用者體驗提升。
- 只有在以下情況下才考慮 SuCo/HNSW/ScaNN 類的解決方案：
  - 語料庫很大（數十萬/數十萬個片段）
  - 硬體搜尋嵌入變得太慢
  - 回憶品質受到詞彙搜尋的明顯瓶頸限制

離線友好的替代方案（按複雜度遞增）：

- SQLite FTS5 + 元資料過濾器（零機器學習）
- 嵌入 + 硬體暴力搜尋（如果區塊數量較少，效果出乎意料地好）
- HNSW 索引（常見、穩健；需要一個函式庫綁定）
- SuCo（研究級；如果有穩固的實作可以嵌入，會很有吸引力）

[[BLOCK_1]]

- 在你的機器（筆記型電腦 + 桌上型電腦）上，什麼是「個人助理記憶」的 **最佳** 離線嵌入模型？
  - 如果你已經有 Ollama：使用本地模型進行嵌入；否則在工具鏈中提供一個小型嵌入模型。

## Smallest useful pilot

如果你想要一個簡約但仍然實用的版本：

- 在每日日誌中新增 `bank/` 實體頁面和 `## Retain` 區段。
- 使用 SQLite FTS 進行引用回顧（路徑 + 行號）。
- 只有在回顧品質或規模需求時才新增嵌入。

## References

- Letta / MemGPT 概念：“核心記憶區塊” + “檔案記憶” + 工具驅動的自我編輯記憶。
- Hindsight 技術報告：“保留 / 回憶 / 反思”，四網路記憶，敘事事實提取，意見信心演變。
- SuCo: arXiv 2411.14754 (2024)：“子空間碰撞”近似最近鄰檢索。
