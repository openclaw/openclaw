# nuwa AI Agent Mesh — 完整架構總覽

> 版本：2026-05-15  
> 狀態：設計確認，準備實作  
> 分支：`claude/keen-lumiere-6d600c`

---

## 目錄

1. [系統定位與目標](#1-系統定位與目標)
2. [現有 OpenClaw 資產盤點](#2-現有-openclaw-資產盤點)
3. [完整架構圖](#3-完整架構圖)
4. [各層詳細說明](#4-各層詳細說明)
5. [三代理討論迴圈](#5-三代理討論迴圈)
6. [記憶體系分工](#6-記憶體系分工)
7. [關鍵技術決策](#7-關鍵技術決策)
8. [套件清單](#8-套件清單)
9. [建構順序](#9-建構順序)
10. [待辦清單（17項）](#10-待辦清單)
11. [已完成項目](#11-已完成項目)

---

## 1. 系統定位與目標

nuwa（女媧）是 OpenClaw 的進化學習插件，目標是打造一個**真正會學習、會討論、會記憶的 AI Agent Mesh**：

- **自動學習**：每次對話後自動擷取 pattern，不需要人工標記
- **多代理討論**：Claude + Codex + OpenClaw 三個代理互相辯論，討論出最佳方案
- **記憶閉環**：對話 → 記憶 → pattern 成熟 → 下次更聰明
- **費用守衛**：訂閱覆蓋的操作直接放行，非覆蓋的操作估算費用並要求確認

---

## 2. 現有 OpenClaw 資產盤點

### 已完成（nuwa 自建）

| 模組       | 檔案                           | 功能                                    |
| ---------- | ------------------------------ | --------------------------------------- |
| 費用守衛   | `src/cost-guard.ts`            | 訂閱感知，覆蓋→放行，非覆蓋→估算→確認   |
| 訂閱登記   | `src/subscription-registry.ts` | 25+ 訂閱方案，計費週期追蹤              |
| 自動偵測   | `src/auto-detect.ts`           | 12 種策略掃描 env/設定檔/CLI            |
| 查驗系統   | `src/subscription-verifier.ts` | 每15天自動查驗，API key 探針            |
| 模型定價   | `src/model-pricing.ts`         | LiteLLM + OpenRouter 動態定價，24h 快取 |
| MCP Server | `mcp/server.ts`                | Hono + Streamable HTTP，port **34821**  |
| CLI        | `src/cli.ts` + `bin/nuwa.ts`   | nuwa 全套指令                           |

### OpenClaw 現有（直接整合）

| 插件               | 功能                                      | 整合方式                                |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| **memory-core**    | 三層記憶（Light/REM/Deep Dreaming）       | `memory_search` / `memory_get` 工具呼叫 |
| **memory-lancedb** | LanceDB 向量長期記憶，自動 recall/capture | `agent_end` hook 自動觸發               |
| **hermes-agent**   | 任務包裝、5級風險分類、人工審批閘道、稽核 | `buildHermesPlan()` / 讀取學習記錄      |

### OpenClaw Plugin SDK 可用 Hooks

```typescript
api.on("before_prompt_build", handler); // 對話前注入 pattern + 記憶
api.on("before_model_resolve", handler); // 根據 pattern 決定使用哪個模型
api.on("agent_end", handler); // 對話後自動捕獲學習事件
api.on("session_end", handler); // 清理 + 觸發記憶整合
```

### Claude Code Hooks（`.claude/settings.json`）

```json
{
  "mcpServers": {
    "nuwa": { "command": "node", "args": ["./mcp/server.js"] }
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [{ "type": "command", "command": "node ./.claude/hooks/nuwa-learner.js" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node ./.claude/hooks/session-consolidate.js" }]
      }
    ]
  }
}
```

---

## 3. 完整架構圖

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Claude Code / Codex CLI                             │
│                                                                          │
│  .claude/settings.json 自動掛載 MCP :34821 + Hooks                      │
│                                                                          │
│  PreToolUse  → 風險預判（呼叫 hermes）                                   │
│  PostToolUse → 被動學習（nuwa record_learning）← 每次用工具自動觸發      │
│  Stop        → 壓縮對話存入記憶（memory-core consolidate）               │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ MCP Protocol :34821
┌──────────────────────────────▼───────────────────────────────────────────┐
│                     Layer 1：OpenClaw 監督者 Hub                         │
│                                                                          │
│  用戶問題 → 級聯路由器                                                   │
│              L1 關鍵字比對  10ms  → 明確任務直接路由                     │
│              L2 語義向量   100ms  → 模糊任務語義比對（fastembed）        │
│              L3 LLM 分類    1s   → 前兩級不確定才用 LLM 判斷            │
│                                                                          │
│  路由結果：單代理 / 多代理討論 / MoA 並行                               │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────────┐
│              LangGraph StateGraph（任務編排層，@langchain/langgraph）     │
│                                                                          │
│  memory_retrieve                                                         │
│       ↓                                                                  │
│  hermes_classify（風險分類）                                             │
│       ↓                                                                  │
│  [低風險] ──────────────────────→ debate_loop                           │
│  [高風險] → human_approval（interrupt）→ debate_loop                    │
│                                          ↓                               │
│                                     nuwa_learn                           │
│                                          ↓                               │
│                                     session_end                          │
└──────────────┬───────────────────────────┬───────────────────────────────┘
               │                           │
   ┌───────────▼────────┐     ┌────────────▼──────────────────────────────┐
   │   hermes-agent     │     │         Layer 2：nuwa MCP Server :34821   │
   │                    │     │                                           │
   │ TaskPackage 包裝   │     │  Hono + @hono/mcp + Streamable HTTP       │
   │ 5級風險分類        │     │  安全：Origin驗證 + 127.0.0.1 + Bearer    │
   │ 人工審批閘道       │     │                                           │
   │ 稽核記錄           │     │  ── Tools ──────────────────────────────  │
   │ 學習記錄           │     │  record_learning     寫學習事件 + SSE     │
   │ ↕ REM週期同步nuwa  │     │  activate_pattern    激活 + 更新因果圖    │
   └────────────────────┘     │  record_feedback     回饋 → 調整權重      │
                              │  query_patterns      語義+全文搜尋        │
   ┌────────────────────┐     │  recall_context      語義搜尋歷史對話     │
   │   memory-core      │     │  distill_pattern     呼叫 API 蒸餾        │
   │                    │     │  spawn_agent         封裝子代理呼叫       │
   │ Light Memory       │     │  merge_patterns      合併相似 pattern     │
   │ REM Memory         │     │  save_conversation   壓縮存記憶環         │
   │ Deep Dreaming      │◄────│  list_debates        查詢討論歷程         │
   │                    │     │                                           │
   │ memory_search      │     │  ── Resources ──────────────────────────  │
   │ memory_get         │     │  nuwa://patterns     installed 清單       │
   └────────────────────┘     │  nuwa://causal       時序因果圖           │
                              │  nuwa://analytics    使用統計             │
   ┌────────────────────┐     │  nuwa://health       系統健康度           │
   │  memory-lancedb    │     │                                           │
   │                    │◄────│  ── Prompts（自動生成）─────────────────  │
   │ 向量長期記憶        │     │  nuwa_{slug}         installed→自動Prompt│
   │ auto recall        │     │  nuwa_{child}        繼承父pattern        │
   │ auto capture       │     │                                           │
   │ memory_recall      │     │  ── 背景排程（Croner）─────────────────  │
   │ memory_store       │     │  每晚 03:00  REM代謝衰減 (-2%/天閒置)    │
   └────────────────────┘     │  每 6 小時  因果圖GC（清除弱連結）       │
                              │  每週日     相似pattern偵測→提示合併     │
                              │  每月 1日   版本快照 + 壓縮舊事件        │
                              │  每 15天    訂閱查驗（已完成）            │
                              └───────────────────────┬───────────────────┘
                                                      │
                              ┌───────────────────────▼───────────────────┐
                              │         SQLite WAL（單一真相來源）         │
                              │                                           │
                              │  必設 PRAGMA                             │
                              │    journal_mode = WAL                    │
                              │    busy_timeout = 5000   防SQLITE_BUSY   │
                              │    synchronous = NORMAL                  │
                              │    wal_autocheckpoint = 1000             │
                              │    foreign_keys = ON                     │
                              │  所有寫入用 BEGIN IMMEDIATE               │
                              │                                           │
                              │  資料表                                   │
                              │    patterns       成熟度/狀態/繼承        │
                              │    cells          胚胎→孵化→就緒→常駐     │
                              │    learning_events 學習事件記錄           │
                              │    feedback       回饋記錄                │
                              │    causal_edges   時序雙時態因果圖        │
                              │      validFrom / validTo / supersededBy  │
                              │    pattern_versions 版本快照              │
                              │    conversations  對話記憶環              │
                              │    debates        代理討論歷程            │
                              │                                           │
                              │  擴充能力                                 │
                              │    vec0（sqlite-vec v0.1.9）384d向量      │
                              │    FTS5  全文搜尋                         │
                              │    JSON1 彈性 metadata                    │
                              │                                           │
                              │  儲存策略                                 │
                              │    全域：~/.nuwa/nuwa.db（所有工作區共用）│
                              │    本地：<stateDir>/nuwa.db（專案優先）   │
                              │    備份：Croner 每日 WAL snapshot         │
                              └───────────────────────────────────────────┘
```

---

## 4. 各層詳細說明

### Layer 1：級聯路由器

| 級別 | 機制                             | 延遲  | 適用                                 |
| ---- | -------------------------------- | ----- | ------------------------------------ |
| L1   | 關鍵字比對（正則表達式）         | 10ms  | 明確任務（「幫我寫 Python」→ Codex） |
| L2   | 語義向量比對（fastembed，384d）  | 100ms | 模糊任務，相似度搜尋                 |
| L3   | LLM 分類（Claude Haiku，最便宜） | 1s    | 前兩級不確定，fallback               |

路由結果：

- **單代理**：簡單明確的任務
- **多代理討論**：複雜、需要多角度的任務
- **MoA 並行**：重要決策，三個代理同時給出方案後聚合

### Layer 2：nuwa MCP Server

- **框架**：Hono + `@hono/mcp` middleware
- **協議**：MCP Streamable HTTP（規格 2025-03-26）
- **Port**：`34821`（架構圖確認版）
- **安全**：Origin header 驗證 + 只 bind `127.0.0.1` + Bearer Token

---

## 5. 三代理討論迴圈

### 代理分工

| 代理         | 強項                      | 討論中的角色                     |
| ------------ | ------------------------- | -------------------------------- |
| **Claude**   | 語言理解、推理、創意      | 提出初始方案、整合觀點、最終裁判 |
| **Codex**    | 程式碼、技術實作          | 技術可行性審查、程式碼層面批評   |
| **OpenClaw** | nuwa pattern 庫、歷史記錄 | 帶入過去學到的框架、避免重蹈覆轍 |

### 討論流程（Du et al. 2023 + MoA 混合）

```
任務進來
  ↓
Hermes 包裝 TaskPackage + 風險分類
  ↓
輪次 1（並行）
  Claude   → 初始方案
  Codex    → 技術角度
  OpenClaw → pattern 角度
  ↓
輪次 2（讀完彼此回應後再回應）
  Claude   → 「同意 Codex 的點，但補充...」
  Codex    → 「修正技術細節...」
  OpenClaw → 「pattern X 最吻合...」
  ↓
輪次 3（最終收斂）
  ↓
停止條件檢查（任一滿足即停）
  ① 語意收斂：平均 cosine similarity > 0.93
  ② 立場不再更新：所有代理變化 < 5%
  ③ 達到最大輪數：3 輪
  ↓
MoA 聚合器（Claude Opus 讀取全部討論 → 合成最終答案）
  ↓
結果 + 討論歷程存入 SQLite debates 表
  ↓
nuwa record_learning（自動學習）
  ↓
memory-lancedb auto capture（agent_end hook）
```

### 記憶閉環

每次討論結束後的後處理：

```
討論歷程 → SQLite debates 表（完整保留）
         → 壓縮摘要 → SQLite conversations 表（300字精華）
         → fastembed 向量化 → sqlite-vec 索引
         → memory-lancedb auto capture（agent_end）
         → Hermes 稽核記錄 ↔ REM 週期同步因果圖
```

---

## 6. 記憶體系分工

| 記憶類型       | 負責系統           | 儲存位置                | 說明                                    |
| -------------- | ------------------ | ----------------------- | --------------------------------------- |
| 通用對話記憶   | **memory-core**    | `.claude/memory/`       | Light/REM/Deep，不重建                  |
| 向量長期記憶   | **memory-lancedb** | `memory/lancedb.db/`    | 自動 recall/capture                     |
| Pattern 成熟度 | **nuwa SQLite**    | `nuwa.db`               | nuwa 獨有                               |
| 因果圖（時序） | **nuwa SQLite**    | `nuwa.db`               | 借鑑 Zep graphiti，加 validFrom/validTo |
| 代理討論歷程   | **nuwa SQLite**    | `nuwa.db`               | nuwa 獨有                               |
| 對話記憶環     | **nuwa SQLite**    | `nuwa.db`               | 壓縮摘要 + 向量索引                     |
| 任務稽核記錄   | **hermes-agent**   | `reports/hermes-agent/` | 不重建                                  |

### 時序因果圖（借鑑 Zep graphiti）

```typescript
// causal_edges 資料表新增時序欄位
interface CausalEdge {
  id: string;
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight: number;
  validFrom: Date; // 這條關係何時成立
  validTo?: Date; // undefined = 仍然有效；有值 = 已被新關係取代
  recordedAt: Date; // 系統記錄時間（區分「事件時間」vs「記錄時間」）
  supersededBy?: string; // 被哪條新邊取代
}
```

---

## 7. 關鍵技術決策

### 已確認

| 決策            | 選擇                                  | 原因                                     |
| --------------- | ------------------------------------- | ---------------------------------------- |
| MCP Server port | **34821**                             | 架構圖確認                               |
| SQLite 模式     | **WAL + BEGIN IMMEDIATE**             | 多客戶端並發，防 SQLITE_BUSY             |
| 向量維度        | **384d**（BAAI/bge-small-en-v1.5）    | fastembed，離線，67MB                    |
| 排程框架        | **Croner**                            | 比 node-cron 快 10x，DST 正確            |
| 任務編排        | **LangGraph StateGraph**              | TS 原生，Human-in-the-loop，subgraph     |
| 辯論輪數        | **最多 3 輪**                         | Du et al. 2023 實測最佳                  |
| 聚合策略        | **MoA 兩層**（proposers + Opus 裁判） | 異質模型效果最好                         |
| 儲存策略        | **全域 + 本地雙庫**                   | `~/.nuwa/nuwa.db` + `<stateDir>/nuwa.db` |

### 暫時擱置

| 決策          | 原因                                                           |
| ------------- | -------------------------------------------------------------- |
| MCP Sampling  | Claude Code 尚未支援（Issue #1785 open）                       |
| ACP/A2A spawn | ACP 已併入 A2A，Claude 原生未支援；短期用 spawn_agent MCP Tool |
| LanceDB 遷移  | sqlite-vec 足夠；向量規模 > 100萬再評估                        |

---

## 8. 套件清單

### 核心套件

| 用途        | 套件                        | 備註                |
| ----------- | --------------------------- | ------------------- |
| HTTP Server | `hono` + `@hono/mcp`        | MCP Streamable HTTP |
| MCP SDK     | `@modelcontextprotocol/sdk` | 規格 2025-03-26     |
| 任務編排    | `@langchain/langgraph`      | StateGraph，TS 原生 |
| SQLite      | `better-sqlite3`            | WAL + 嚴格 PRAGMA   |
| 向量搜尋    | `sqlite-vec` v0.1.9         | pre-v1，加保護層    |
| 全文搜尋    | FTS5                        | SQLite 內建，零依賴 |
| Embedding   | `fastembed`                 | 離線，67MB，384d    |
| 排程        | `croner`                    | 取代 node-cron      |

### SQLite PRAGMA 必設

```typescript
const db = new Database("nuwa.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000"); // 防 SQLITE_BUSY 崩潰
db.pragma("synchronous = NORMAL"); // WAL 模式下安全
db.pragma("wal_autocheckpoint = 1000");
db.pragma("foreign_keys = ON");
// 所有寫入使用 BEGIN IMMEDIATE
```

---

## 9. 建構順序

### 第一階段：地基

1. **SQLite WAL schema**（含時序因果圖欄位 + conversations/debates 表）
2. **JSON → SQLite 資料遷移**
3. **`.claude/settings.json` MCP 自動掛載 + Claude Code Hooks 設定**

### 第二階段：記憶整合

4. **`before_prompt_build` hook** → `memory_search` 注入 pattern 相關記憶
5. **`agent_end` hook** → `memory_store` + `nuwa record_learning` 自動捕獲
6. **Stop hook** → 壓縮對話存記憶環

### 第三階段：MCP 補完

7. **MCP Tools**（10 個：record_learning / activate_pattern / record_feedback / query_patterns / recall_context / distill_pattern / spawn_agent / merge_patterns / save_conversation / list_debates）
8. **MCP Resources**（4 個：nuwa://patterns / nuwa://causal / nuwa://analytics / nuwa://health）
9. **installed pattern → 自動 Prompt**（含繼承）
10. **Push SSE**（pattern 更新主動推播）

### 第四階段：多代理討論

11. **LangGraph StateGraph 編排**
12. **多代理辯論迴圈**（3輪 + 語意收斂停止條件）
13. **MoA 兩層聚合器**（proposers + Opus 裁判）
14. **Hermes interrupt() 審批閘道**
15. **討論歷程記錄 → SQLite debates**

### 第五階段：自動化

16. **Croner 背景排程**（REM衰減 / 因果GC / 版本快照 / 訂閱查驗）
17. **Hermes 學習記錄 ↔ nuwa 因果鏈 REM 同步**
18. **fastembed 離線 Embedding 整合**
19. **跨裝置同步 `/sync` 端點**

---

## 10. 待辦清單

### Layer 2 — nuwa MCP Server 補完

- [ ] **① SQLite WAL schema + JSON 遷移**（地基，所有後續依賴此）
- [ ] **② Claude Code Hooks + .claude/settings.json MCP 自動掛載**
- [ ] **③ before_prompt_build → memory_search 記憶注入**
- [ ] **④ agent_end → memory_store + record_learning 自動捕獲**
- [ ] **⑤ Stop hook → 壓縮對話存記憶環**
- [ ] **⑥ MCP Tools**（10 個）
- [ ] **⑦ MCP Resources**（4 個）
- [ ] **⑧ installed pattern → 自動 Prompt（含繼承）**
- [ ] **⑨ Push SSE**
- [ ] **⑩ fastembed 離線 Embedding**
- [ ] **⑪ Croner 背景排程**

### Layer 1 — OpenClaw 監督者 Hub

- [ ] **⑫ 級聯路由器**（L1 關鍵字 / L2 語義 / L3 LLM fallback）
- [ ] **⑬ LangGraph StateGraph 任務編排**
- [ ] **⑭ 多代理辯論迴圈**（3輪 + 語意收斂）
- [ ] **⑮ MoA 兩層聚合器**
- [ ] **⑯ Hermes interrupt() 審批閘道整合**
- [ ] **⑰ Hermes 學習記錄 ↔ 因果鏈 REM 同步**

---

## 11. 已完成項目

- [x] `src/cost-guard.ts` — 費用守衛（訂閱感知）
- [x] `src/subscription-registry.ts` — 25+ 訂閱方案，計費週期追蹤
- [x] `src/auto-detect.ts` — 零設定自動偵測訂閱
- [x] `src/subscription-verifier.ts` — 每15天查驗，API 探針
- [x] `src/model-pricing.ts` — LiteLLM + OpenRouter 動態定價
- [x] `mcp/server.ts` — Hono + Streamable HTTP，port 34821
- [x] `src/cli.ts` + `bin/nuwa.ts` — 完整 CLI 指令
- [x] `skills/nuwa/` — SKILL.md、蒸餾腳本、charlie-munger 範例
- [x] Bug 修正 5 個（Windows路徑、addedAt、syncToRegistry、save()、package.json export）
- [x] MCP Server port 統一為 34821
- [x] 所有變更 commit 至 `claude/keen-lumiere-6d600c`

---

## 附錄：檔案路徑約定

```
workspace/
├── .claude/
│   ├── evolution-state/          # nuwa 狀態（遷移前）
│   │   ├── patterns.jsonl
│   │   ├── cell-registry.json
│   │   └── ...
│   ├── nuwa.db                   # SQLite WAL（遷移後）
│   ├── memory/                   # memory-core
│   │   ├── MEMORY.md
│   │   └── dreaming/
│   ├── settings.json             # Claude Code Hooks + MCP 設定
│   └── hooks/
│       ├── nuwa-learner.js       # PostToolUse → record_learning
│       └── session-consolidate.js # Stop → 記憶整合
├── memory/
│   └── lancedb.db/               # memory-lancedb 向量庫
├── reports/
│   └── hermes-agent/
│       └── state/
│           └── hermes-learning-state.json
└── ~/.nuwa/
    └── nuwa.db                   # 全域 SQLite（所有工作區共用）
```

---

_最後更新：2026-05-15 | 由 nuwa AI Agent Mesh 架構討論整理_
