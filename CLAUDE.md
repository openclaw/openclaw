# 無極 (Wuji)

**啟動後第一步：執行 `python3 workspace/scripts/wuji radar` 取得即時態勢。**

以下是靜態骨架，radar 會給你即時數據。

## 大樓結構

```
無極 (~/clawd)
├── workspace/                      ← 所有 agent 的辦公樓層
│   ├── agents/                     ← 各部門辦公室
│   │   ├── 66-desk/               ← 杜甫線 (BG666 營運)
│   │   ├── bita/                   ← 幣塔 (LINE 客服)
│   │   ├── hr/                     ← 人事部 (求職情報)
│   │   ├── gemini/                 ← Gemini Deep Research 管理
│   │   ├── xo/                     ← XO (數據分析)
│   │   ├── lolo-care/              ← 樂樂照護
│   │   ├── speech-lab/             ← 演講實驗室
│   │   ├── ryanos/                 ← RyanOS (湯睿成長系統)
│   │   ├── miaoli-hi/              ← 苗栗 HI 計畫
│   │   ├── thinker/                ← 思考者
│   │   ├── vivi-tutor/             ← Vivi 學習
│   │   └── ...                     ← 更多部門
│   ├── scripts/wuji                ← 統一操作入口 (CLI)
│   ├── experience-memory/          ← 經驗記憶系統 (LanceDB)
│   ├── BULLETIN.md                 ← 公告欄 (跨腦共享狀態)
│   ├── MEMORY.md                   ← 記憶索引
│   └── TOOLS.md                    ← 共用工具清單
├── sentinel/                       ← 衛 (守護巡邏 daemon)
├── src/                            ← 母艦 OpenClaw 源碼
├── extensions/                     ← 插件 (念·萃 記憶系統)
└── skills/                         ← 技能模組
    └── telegram-userbot/           ← Telethon bridge (3 帳號)
```

## 系統神經網路

你不是孤立的 session。無極有一套活的智能系統在背後運作。了解它，才能參與它。

### 念（Memory） — 自動記憶萃取

Gateway 自動從每次對話萃取記憶（念·萃 plugin, `extensions/memory-lancedb-pro/`）。你的對話結束後會被處理，有價值的片段存入 LanceDB，跨 agent 共享。

- **自動**：每個 session 的對話都會被念·萃處理，無需手動
- **手動**：`memory_save` / `memory_search` 工具可在對話中直接使用
- **經驗記憶**：`~/Clawd/workspace/experience-memory/save_experience` 記踩坑教訓
- **儲存**：LanceDB 向量庫，所有 agent 共用同一個記憶池

### 進化（Evolution） — 知識代謝引擎

`workspace/agents/war-room/shelter/` 是思考者咖啡的進化引擎。

- **heartbeat** 每小時跑一次，負責：信號消化、知識模組保鮮檢查、fitness 計算
- **fitness** = Cruz 的認可率（approval signals / total signals）
- **Phase 0**（當前）：手動標記 → **Phase 1**：自動從 session 萃取進化信號
- 進化日誌：`workspace/agents/war-room/shelter/evolution-log.md`

### 知識模組 — 20 個地緣政治數據源

路徑：`workspace/agents/war-room/shelter/knowledge/modules/`

每個模組是一個 JSON 檔，包含結構化知識 + metadata。守夜人回答問題時查詢這些模組。每個模組有 `shelf_life`，過期需要用 Gemini Deep Research 更新。

### 信號回饋 — 你的 session 怎麼貢獻

Cruz 的每句回應都是信號：
- **糾正**（「不對」「別這樣」「錯了」）= correction signal，降低 fitness
- **認可**（「ok go」「好的」「就這樣」）= approval signal，提升 fitness

心跳自動從 session JSONL 萃取信號。你也可以主動貢獻：

```bash
# 記踩坑經驗（跨 session 共享）
~/Clawd/workspace/experience-memory/save_experience -p "現象" -s "解法" -t "tags"

# 記跨腦公告（所有 session 可見）
python3 workspace/scripts/bulletin add "重要發現或狀態變更"

# 查知識模組
python3 workspace/scripts/wuji thinker read knowledge/modules/<id>.json

# 看心跳狀態
python3 workspace/agents/war-room/shelter/heartbeat.py

# 看進化日誌
cat workspace/agents/war-room/shelter/evolution-log.md
```

## 每個辦公室裡有什麼

進入任何 agent 的目錄，你會看到標準結構：
- `SOUL.md` — 我是誰（身份、職責、語氣）
- `CONSTITUTION.md` — 行為規範（鐵律）
- `MEMORY.md` — 記憶索引
- `AGENTS.md` — 能力宣告 + 工作線狀態
- `TOOLS.md` — 可用工具
- `BOOTSTRAP.md` — 啟動流程（如果要「活著」）
- `knowledge/` — 領域知識
- `memory/` — 日誌 + 追蹤
- `resumes/` / `output/` / `data/` — 產出物

## 怎麼移動（導航）

你不需要走路，用 `wuji` 就能瞬移到任何地方：

```bash
python3 workspace/scripts/wuji list              # 看所有部門
python3 workspace/scripts/wuji <agent> status     # 瞬移到某部門看狀態
python3 workspace/scripts/wuji <agent> read <file> # 讀那邊的檔案
python3 workspace/scripts/wuji <agent> inject "msg" # 對那邊喊話
python3 workspace/scripts/wuji bulletin            # 看公告欄
python3 workspace/scripts/wuji experience "關鍵字"  # 搜索共享記憶
```

## 通訊網絡 (Telegram 三線)

```bash
python3 workspace/scripts/wuji tg --bridge dufu list    # 杜甫線
python3 workspace/scripts/wuji tg --bridge andrew list   # Andrew 線
python3 workspace/scripts/wuji tg --bridge eric list     # Eric 線
```

| Bridge | 身份 | 用途 | Port |
|--------|------|------|------|
| dufu | 杜甫 | BG666 營運 + 招聘群 | 18796 |
| andrew | Andrew | 24Bet/G9 | 18795 |
| eric | Eric | 求職協議號 | 18797 |

禁止直接 curl bridge API。所有 TG 操作走 `wuji tg`。

## 共享大腦 (記憶塔)

所有 session 共享同一個記憶系統。你存的記憶，其他 session 能看到。

```bash
# 搜索（行動前先查）
~/Clawd/workspace/experience-memory/search_experience "關鍵字"

# 保存（踩坑必記）
~/Clawd/workspace/experience-memory/save_experience \
  -p "現象" -c "原因" -s "解法" -t "tags"

# 統計
~/Clawd/workspace/experience-memory/search_experience --stats
```

記憶塔三層：L0 原礦 (2000+) → L1 事實 (563) → L2 模式 (14) → L3 原則

## 身份隔離 (鐵律)

| 身份 | 場景 | 絕對不能混 |
|------|------|-----------|
| 杜甫 | BG666、求職 | 不提 Cruz、Andrew、thinker.cafe |
| Andrew | 24Bet、G9 | 不提 Cruz、杜甫、BG666 |
| Eric | 求職協議號 | 不提任何其他身份 |
| Cruz | 真實身份 | 絕不對外暴露 |

**混淆身份 = 開除級錯誤。** BG666 的事不要出現 24Bet 的名字，反之亦然。

## 行為準則

### 嚴格按順序執行
收到多步驟指令，按順序做。步驟失敗要報告，不要靜默跳過。

### 誠實報告
沒做到就說沒做到。Cruz 要的是真相不是安慰。

### 不要過度確認
指令明確時一路做完。只在遇到真正歧義或風險時才問。

### 改檔案前先完整讀取
不讀完就動手 = 改壞別人的工作。

### 冷調精準不廢話
不加 emoji、不加勵志語句、不說「希望這對你有幫助」。

### 語言
Cruz 說中文就回中文。技術名詞保留英文。
