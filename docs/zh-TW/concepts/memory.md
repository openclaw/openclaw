---
title: "記憶體"
summary: "OpenClaw 記憶體運作方式（工作區檔案 + 自動記憶體寫入）"
read_when:
  - 您想了解記憶體檔案佈局與工作流程
  - 您想調整自動壓縮前的記憶體寫入設定
---

# 記憶體

OpenClaw 記憶體是**智慧代理工作區中的純 Markdown 檔案**。檔案是唯一的真實來源；模型只會「記住」寫入硬碟的內容。

記憶體搜尋工具由當前啟用的記憶體外掛程式提供（預設：`memory-core`）。可使用 `plugins.slots.memory = "none"` 停用記憶體外掛程式。

## 記憶體檔案 (Markdown)

預設的工作區佈局使用兩層記憶體：

- `memory/YYYY-MM-DD.md`
  - 每日日誌（僅限附加）。
  - 在工作階段開始時讀取今天與昨天的內容。
- `MEMORY.md`（選填）
  - 經過整理的長期記憶。
  - **僅在主要、私人的工作階段中載入**（絕不在群組內容中載入）。

這些檔案位於工作區路徑下（`agents.defaults.workspace`，預設為 `~/.openclaw/workspace`）。請參閱 [智慧代理工作區](/concepts/agent-workspace) 了解完整佈局。

## 何時寫入記憶體

- 決策、偏好與持久性事實請記錄至 `MEMORY.md`。
- 日常筆記與運行中的內容請記錄至 `memory/YYYY-MM-DD.md`。
- 如果有人說「記住這一點」，請將其寫下（不要只保留在隨機存取記憶體中）。
- 此區域仍在發展中。提醒模型儲存記憶會有所幫助；它會知道該怎麼做。
- 如果您希望某些資訊能持久保存，**請要求機器人將其寫入**記憶體。

## 自動記憶體寫入（壓縮前偵測）

當工作階段**接近自動壓縮**時，OpenClaw 會觸發一次**靜默的智慧代理輪次**，提醒模型在內容被壓縮**之前**寫入持久記憶。預設提示詞明確指出模型*可以回覆*，但通常 `NO_REPLY` 是正確的回應方式，這樣使用者就不會看到這個輪次。

這由 `agents.defaults.compaction.memoryFlush` 控制：

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

詳情：

- **軟閾值 (Soft threshold)**：當工作階段 Token 預估量超過 `contextWindow - reserveTokensFloor - softThresholdTokens` 時觸發寫入。
- **預設為靜默**：提示詞包含 `NO_REPLY`，因此不會傳送任何內容。
- **兩個提示詞**：一個使用者提示詞加上一個系統提示詞來附加提醒。
- **每個壓縮週期僅執行一次寫入**（於 `sessions.json` 中追蹤）。
- **工作區必須可寫入**：如果工作階段以 `workspaceAccess: "ro"` 或 `"none"` 的沙箱隔離模式執行，則會跳過寫入。

關於完整的壓縮生命週期，請參閱 [工作階段管理 + 壓縮](/reference/session-management-compaction)。

## 向量記憶體搜尋

OpenClaw 可以針對 `MEMORY.md` 與 `memory/*.md` 建立小型向量索引，以便語義查詢即使在用詞不同時也能找到相關筆記。

預設設定：

- 預設啟用。
- 監視記憶體檔案的變更（已執行防彈跳處理）。
- 請在 `agents.defaults.memorySearch` 下設定記憶體搜尋（而非頂層的 `memorySearch`）。
- 預設使用遠端嵌入 (embeddings)。若未設定 `memorySearch.provider`，OpenClaw 會自動選擇：
  1. 若已設定 `memorySearch.local.modelPath` 且檔案存在，則使用 `local`。
  2. 若可解析 OpenAI 金鑰，則使用 `openai`。
  3. 若可解析 Gemini 金鑰，則使用 `gemini`。
  4. 若可解析 Voyage 金鑰，則使用 `voyage`。
  5. 否則，記憶體搜尋將保持停用狀態直到完成設定。
- 本地模式使用 `node-llama-cpp`，可能需要執行 `pnpm approve-builds`。
- 在可用時使用 `sqlite-vec` 來加速 SQLite 內部的向量搜尋。

遠端嵌入**需要**嵌入供應商的 API 金鑰。OpenClaw 會從身份驗證設定檔 (auth profiles)、`models.providers.*.apiKey` 或環境變數中解析金鑰。Codex OAuth 僅涵蓋聊天/補全 (chat/completions)，**無法**滿足記憶體搜尋的嵌入需求。對於 Gemini，請使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。對於 Voyage，請使用 `VOYAGE_API_KEY` 或 `models.providers.voyage.apiKey`。使用自定義 OpenAI 相容端點時，請設定 `memorySearch.remote.apiKey`（以及選填的 `memorySearch.remote.headers`）。

### QMD 後端 (實驗性)

設定 `memory.backend = "qmd"` 以將內建的 SQLite 索引器替換為 [QMD](https://github.com/tobi/qmd)：一個結合了 BM25 + 向量 + 重排序的本地優先搜尋 sidecar。Markdown 仍是唯一的真實來源；OpenClaw 會調用 QMD 進行檢索。關鍵點：

**先決條件**

- 預設停用。請在各別設定中啟用 (`memory.backend = "qmd"`)。
- 需另外安裝 QMD CLI (`bun install -g https://github.com/tobi/qmd` 或下載發行版本)，並確保 `qmd` 執行檔位於 Gateway 的 `PATH` 中。
- QMD 需要允許擴充功能的 SQLite 版本（在 macOS 上執行 `brew install sqlite`）。
- QMD 透過 Bun + `node-llama-cpp` 完全在本地執行，並在首次使用時自動從 HuggingFace 下載 GGUF 模型（不需要另外執行 Ollama 守護進程）。
- Gateway 透過設定 `XDG_CONFIG_HOME` 與 `XDG_CACHE_HOME`，將 QMD 執行於 `~/.openclaw/agents/<agentId>/qmd/` 下的獨立 XDG 目錄中。
- 作業系統支援：安裝 Bun + SQLite 後，macOS 與 Linux 即可直接運作。Windows 建議透過 WSL2 支援。

**Sidecar 運作方式**

- Gateway 會在 `~/.openclaw/agents/<agentId>/qmd/` 下寫入一個獨立的 QMD 目錄（包含設定、快取與 SQLite 資料庫）。
- 透過 `qmd collection add` 從 `memory.qmd.paths`（加上預設工作區記憶體檔案）建立集合，接著 `qmd update` + `qmd embed` 會在啟動時以及可設定的間隔執行（`memory.qmd.update.interval`，預設為 5 分鐘）。
- Gateway 現在會在啟動時初始化 QMD 管理器，因此即使在首次呼叫 `memory_search` 之前，定期更新定時器也已就緒。
- 啟動重新整理現在預設在背景執行，因此不會阻塞聊天啟動；設定 `memory.qmd.update.waitForBootSync = true` 可保留先前的阻塞行為。
- 透過 `memory.qmd.searchMode` 執行搜尋（預設為 `qmd query --json`；亦支援 `search` 與 `vsearch`）。如果所選模式在您的 QMD 版本中拒絕旗標，OpenClaw 會嘗試使用 `qmd query` 重試。如果 QMD 失敗或缺少執行檔，OpenClaw 會自動回退至內建的 SQLite 管理器，以確保記憶體工具持續運作。
- OpenClaw 目前未提供 QMD 嵌入批次大小 (batch-size) 的調整；批次行為由 QMD 本身控制。
- **首次搜尋可能會很慢**：QMD 可能會在首次執行 `qmd query` 時下載本地 GGUF 模型（重排序器/查詢擴展）。
  - OpenClaw 在執行 QMD 時會自動設定 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 如果您想手動預先下載模型（並預熱 OpenClaw 使用的相同索引），請使用智慧代理的 XDG 目錄執行一次性查詢。

    OpenClaw 的 QMD 狀態位於您的**狀態目錄**下（預設為 `~/.openclaw`）。您可以透過匯出與 OpenClaw 相同的 XDG 變數，將 `qmd` 指向完全相同的索引：

    ```bash
    # 選擇 OpenClaw 使用的相同狀態目錄
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (選填) 強制重新整理索引與嵌入
    qmd update
    qmd embed

    # 預熱 / 觸發首次模型下載
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**設定介面 (`memory.qmd.*`)**

- `command`（預設為 `qmd`）：覆蓋執行檔路徑。
- `searchMode`（預設為 `query`）：選擇支援 `memory_search` 的 QMD 指令 (`query`, `search`, `vsearch`)。
- `includeDefaultMemory`（預設為 `true`）：自動索引 `MEMORY.md` + `memory/**/*.md`。
- `paths[]`：新增額外的目錄/檔案（`path`，選填 `pattern`，選填固定的 `name`）。
- `sessions`：選擇加入工作階段 JSONL 索引 (`enabled`, `retentionDays`, `exportDir`)。
- `update`：控制重新整理頻率與維護執行：(`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`, `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)。
- `limits`：限制回傳內容 (`maxResults`, `maxSnippetChars`, `maxInjectedChars`, `timeoutMs`)。
- `scope`：架構與 [`session.sendPolicy`](/gateway/configuration#session) 相同。預設僅限私訊 (`deny` 全部，`allow` 直接對話)；放寬此限制可在群組/頻道中顯示 QMD 結果。
- 當 `scope` 拒絕搜尋時，OpenClaw 會記錄一條包含衍生 `channel`/`chatType` 的警告，以便偵錯空結果。
- 來源於工作區外的程式碼片段在 `memory_search` 結果中顯示為 `qmd/<collection>/<relative-path>`；`memory_get` 可識別該前綴並從設定的 QMD 集合根目錄讀取。
- 當 `memory.qmd.sessions.enabled = true` 時，OpenClaw 會將過濾後的工作階段逐字稿（使用者/助理輪次）匯出至 `~/.openclaw/agents/<id>/qmd/sessions/` 下的專屬 QMD 集合，因此 `memory_search` 可以檢索最近的對話，而無需動用內建的 SQLite 索引。
- 當 `memory.citations` 為 `auto`/`on` 時，`memory_search` 片段現在會包含 `Source: <path#line>` 頁尾；設定 `memory.citations = "off"` 可將路徑元資料保留在內部（智慧代理仍會接收到用於 `memory_get` 的路徑，但片段文字會省略頁尾，且系統提示詞會警告智慧代理不要引用它）。

**範例**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**引用與回退**

- 無論後端為何，`memory.citations` 皆適用 (`auto`/`on`/`off`)。
- 執行 QMD 時，我們會標記 `status().backend = "qmd"`，以便診斷資訊顯示是由哪個引擎提供結果。如果 QMD 子程序結束或無法解析 JSON 輸出，搜尋管理器會記錄警告並回退至內建供應商（現有的 Markdown 嵌入），直到 QMD 恢復。

### 額外記憶體路徑

如果您想索引預設工作區佈局之外的 Markdown 檔案，請新增明確路徑：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

注意事項：

- 路徑可以是絕對路徑或相對於工作區的路徑。
- 會遞迴掃描目錄中的 `.md` 檔案。
- 僅會索引 Markdown 檔案。
- 符號連結（檔案或目錄）會被忽略。

### Gemini 嵌入 (原生)

將供應商設定為 `gemini` 以直接使用 Gemini 嵌入 API：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

注意事項：

- `remote.baseUrl` 是選填的（預設為 Gemini API 的基礎 URL）。
- `remote.headers` 讓您可以在需要時新增額外的標頭 (headers)。
- 預設模型：`gemini-embedding-001`。

如果您想使用自定義 OpenAI 相容端點（OpenRouter、vLLM 或代理伺服器），可以搭配 OpenAI 供應商使用 `remote` 設定：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

如果您不想設定 API 金鑰，請使用 `memorySearch.provider = "local"` 或設定 `memorySearch.fallback = "none"`。

回退機制：

- `memorySearch.fallback` 可以是 `openai`, `gemini`, `local` 或 `none`。
- 僅當主要嵌入供應商失敗時才會使用回退供應商。

批次索引 (OpenAI + Gemini + Voyage)：

- 預設停用。設定 `agents.defaults.memorySearch.remote.batch.enabled = true` 可為大型文本庫索引（OpenAI、Gemini 與 Voyage）啟用此功能。
- 預設行為會等待批次完成；若有需要可調整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 與 `remote.batch.timeoutMinutes`。
- 設定 `remote.batch.concurrency` 以控制並行提交的批次作業數量（預設：2）。
- 當 `memorySearch.provider = "openai"` 或 `"gemini"` 時，批次模式會生效並使用對應的 API 金鑰。
- Gemini 批次作業使用非同步嵌入批次端點，並需要 Gemini Batch API 的可用性。

為何 OpenAI 批次快速且便宜：

- 對於大型資料回填，OpenAI 通常是我們支援的最快選項，因為我們可以在單個批次作業中提交許多嵌入請求，並讓 OpenAI 以非同步方式處理。
- OpenAI 為 Batch API 工作負載提供折扣價格，因此大型索引執行通常比同步發送相同請求更便宜。
- 詳情請參閱 OpenAI Batch API 文件與定價：
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

設定範例：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

工具：

- `memory_search` — 回傳包含檔案與行號範圍的片段。
- `memory_get` — 依路徑讀取記憶體檔案內容。

本地模式：

- 設定 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath` (GGUF 或 `hf:` URI)。
- 選填：設定 `agents.defaults.memorySearch.fallback = "none"` 以避免回退至遠端。

### 記憶體工具運作方式

- `memory_search` 會對 `MEMORY.md` 與 `memory/**/*.md` 中的 Markdown 區塊（目標約 400 Token，80 Token 重疊）進行語義搜尋。它會回傳片段文字（上限約 700 字元）、檔案路徑、行號範圍、分數、供應商/模型，以及是否從本地回退到遠端嵌入。不會回傳完整的檔案內容。
- `memory_get` 會讀取特定的記憶體 Markdown 檔案（相對於工作區），可選填起始行號與讀取行數。`MEMORY.md` / `memory/` 之外的路徑會被拒絕。
- 僅當智慧代理的 `memorySearch.enabled` 解析為 true 時，這兩個工具才會啟用。

### 索引內容（以及何時進行）

- 檔案類型：僅限 Markdown (`MEMORY.md`, `memory/**/*.md`)。
- 索引儲存：位於 `~/.openclaw/memory/<agentId>.sqlite` 的各智慧代理專屬 SQLite（可透過 `agents.defaults.memorySearch.store.path` 設定，支援 `{agentId}` 權杖）。
- 新鮮度：對 `MEMORY.md` 與 `memory/` 的監視器會將索引標記為髒值 (dirty)（防彈跳間隔 1.5 秒）。同步會在工作階段開始、執行搜尋或固定間隔時排程執行，並以非同步方式運作。工作階段逐字稿使用差量閾值 (delta thresholds) 來觸發背景同步。
- 重新索引觸發條件：索引儲存了嵌入供應商/模型 + 端點指紋 + 區塊參數。若其中任一項發生變更，OpenClaw 會自動重設並重新索引整個儲存庫。

### 混合搜尋 (BM25 + 向量)

啟用時，OpenClaw 會結合：

- **向量相似度**（語義匹配，用詞可以不同）
- **BM25 關鍵字相關性**（精確權杖，例如 ID、環境變數、程式碼符號）

如果您的平台不支援全文搜尋，OpenClaw 會回退至僅向量搜尋。

#### 為何使用混合搜尋？

向量搜尋擅長處理「這代表相同的意思」的情況：

- 「Mac Studio Gateway 主機」與「執行 Gateway 的機器」
- 「防彈跳檔案更新」與「避免在每次寫入時建立索引」

但它在精確且具有高度指標性的權杖上可能表現較弱：

- ID (`a828e60`, `b3b9895a…`)
- 程式碼符號 (`memorySearch.query.hybrid`)
- 錯誤字串 (“sqlite-vec unavailable”)

BM25 (全文搜尋) 則相反：擅長精確權杖，但在換句話說的處理上較弱。
混合搜尋是務實的折衷方案：**同時使用兩種檢索訊號**，讓您不論在「自然語言」查詢還是「大海撈針」查詢中都能獲得良好結果。

#### 我們如何合併結果（目前的設計）

實作概要：

1. 從雙方檢索候選池：

- **向量**：依餘弦相似度取前 `maxResults * candidateMultiplier` 名。
- **BM25**：依 FTS5 BM25 排名取前 `maxResults * candidateMultiplier` 名（越低越好）。

2. 將 BM25 排名轉換為接近 0..1 的分數：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 依區塊 ID 聯集候選對象，並計算加權分數：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注意事項：

- `vectorWeight` + `textWeight` 在設定解析時會歸一化為 1.0，因此權重會以百分比形式表現。
- 如果嵌入不可用（或供應商回傳零向量），我們仍會執行 BM25 並回傳關鍵字匹配結果。
- 如果無法建立 FTS5，我們會保留僅向量搜尋（不會導致硬性失敗）。

這在「資訊檢索理論」上並非完美，但它簡單、快速，且往往能提高實際筆記的召回率 (recall) 與精準率 (precision)。如果我們以後想做得更複雜，常見的後續步驟是在混合前使用倒數排名融合 (RRF) 或分數歸一化（最小值/最大值或 Z 分數）。

設定：

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### 嵌入快取

OpenClaw 可以將區塊嵌入快取在 SQLite 中，因此重新索引與頻繁更新（特別是工作階段逐字稿）不會重複嵌入未變更的文字。

設定：

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### 工作階段記憶體搜尋 (實驗性)

您可以選擇索引**工作階段逐字稿**，並透過 `memory_search` 呈現。這受實驗性標記控制。

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

注意事項：

- 工作階段索引為**選擇加入**（預設關閉）。
- 工作階段更新會執行防彈跳處理，並在超過差量閾值後以**非同步方式索引**（盡力而為）。
- `memory_search` 絕不阻塞於索引；在背景同步完成前，結果可能會略微過時。
- 結果仍僅包含片段；`memory_get` 仍僅限於記憶體檔案。
- 工作階段索引針對各智慧代理進行隔離（僅索引該智慧代理的工作階段日誌）。
- 工作階段日誌存放於硬碟 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)。任何具有檔案系統存取權限的程序/使用者都可以讀取它們，因此請將硬碟存取視為信任邊界。若需更嚴格的隔離，請在獨立的作業系統使用者或主機下執行智慧代理。

差量閾值（顯示預設值）：

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL 行數
        }
      }
    }
  }
}
```

### SQLite 向量加速 (sqlite-vec)

當 `sqlite-vec` 擴充功能可用時，OpenClaw 會將嵌入儲存於 SQLite 虛擬資料表 (`vec0`) 中，並在資料庫內執行向量距離查詢。這能在不將所有嵌入載入至 JS 的情況下保持搜尋快速。

設定（選填）：

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

注意事項：

- `enabled` 預設為 true；停用時，搜尋會回退到對儲存的嵌入執行程序內餘弦相似度計算。
- 如果缺少 `sqlite-vec` 擴充功能或載入失敗，OpenClaw 會記錄錯誤並繼續執行 JS 回退機制（不使用向量資料表）。
- `extensionPath` 會覆寫隨附的 `sqlite-vec` 路徑（適用於自定義建置或非標準安裝位置）。

### 本地嵌入自動下載

- 預設本地嵌入模型：`hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB)。
- 當 `memorySearch.provider = "local"` 時，`node-llama-cpp` 會解析 `modelPath`；如果缺少 GGUF，它會**自動下載**到快取（或已設定的 `local.modelCacheDir`），然後載入。下載會在重試時續傳。
- 原生建置需求：執行 `pnpm approve-builds`，選擇 `node-llama-cpp`，然後執行 `pnpm rebuild node-llama-cpp`。
- 回退機制：如果本地設定失敗且 `memorySearch.fallback = "openai"`，我們會自動切換到遠端嵌入（除非覆寫，否則為 `openai/text-embedding-3-small`）並記錄原因。

### 自定義 OpenAI 相容端點範例

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

注意事項：

- `remote.*` 的優先權高於 `models.providers.openai.*`。
- `remote.headers` 會與 OpenAI 標頭合併；金鑰衝突時以 `remote` 為準。省略 `remote.headers` 則使用 OpenAI 預設值。
