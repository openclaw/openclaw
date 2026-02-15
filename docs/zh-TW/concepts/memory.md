---
title: "記憶體"
summary: "OpenClaw 記憶體如何運作 (工作區檔案 + 自動記憶體清除)"
read_when:
  - 您想了解記憶體檔案佈局和工作流程
  - 您想調整自動預壓縮記憶體清除
---

# 記憶體

OpenClaw 記憶體是**智慧代理工作區中的純粹 Markdown**。檔案是事實的來源；模型只「記住」寫入磁碟的內容。

記憶體搜尋工具由作用中的記憶體插件提供（預設：`memory-core`）。使用 `plugins.slots.memory = "none"` 停用記憶體插件。

## 記憶體檔案 (Markdown)

預設工作區佈局使用兩個記憶體層：

- `memory/YYYY-MM-DD.md`
  - 每日日誌（僅追加）。
  - 在工作階段開始時讀取今天 + 昨天。
- `MEMORY.md` (選用)
  - 精選的長期記憶體。
  - **僅在主要、私密工作階段載入**（從不載入於群組情境中）。

這些檔案位於工作區下 (`agents.defaults.workspace`，預設 `~/.openclaw/workspace`)。有關完整佈局，請參閱 [智慧代理工作區](/concepts/agent-workspace)。

## 何時寫入記憶體

- 決策、偏好和持久性事實儲存於 `MEMORY.md`。
- 日常筆記和運行情境儲存於 `memory/YYYY-MM-DD.md`。
- 如果有人說「記住這個」，請寫下來（不要保留在 RAM 中）。
- 這個領域仍在發展中。提醒模型儲存記憶體會很有幫助；它會知道該怎麼做。
- 如果您希望某些內容持續存在，**請要求機器人將其寫入**記憶體。

## 自動記憶體清除 (預壓縮 ping)

當工作階段**接近自動壓縮**時，OpenClaw 會觸發一個**靜默的、智慧代理的回合**，提醒模型在情境被壓縮**之前**寫入持久性記憶體。預設的提示明確表示模型_可能會回覆_，但通常 `NO_REPLY` 是正確的回應，這樣使用者永遠不會看到這個回合。

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

- **軟閾值**：當工作階段 token 估計值超過 `contextWindow - reserveTokensFloor - softThresholdTokens` 時觸發清除。
- **預設靜默**：提示包含 `NO_REPLY`，因此不傳遞任何內容。
- **兩個提示**：使用者提示和系統提示會附加提醒。
- **每個壓縮週期一次清除**（在 `sessions.json` 中追蹤）。
- **工作區必須可寫入**：如果工作階段在沙箱隔離模式下運行，且 `workspaceAccess: "ro"` 或 `"none"`，則會跳過清除。

有關完整的壓縮生命週期，請參閱 [工作階段管理 + 壓縮](/reference/session-management-compaction)。

## 向量記憶體搜尋

OpenClaw 可以在 `MEMORY.md` 和 `memory/*.md` 上建立一個小的向量索引，這樣即使措辭不同，語義查詢也能找到相關筆記。

預設值：

- 預設啟用。
- 監視記憶體檔案的更改（防抖動處理）。
- 在 `agents.defaults.memorySearch` 下設定記憶體搜尋（不是頂層 `memorySearch`）。
- 預設使用遠端嵌入。如果未設定 `memorySearch.provider`，OpenClaw 會自動選擇：
  1. 如果已設定 `memorySearch.local.modelPath` 且檔案存在，則為 `local`。
  2. 如果可以解析 OpenAI 金鑰，則為 `openai`。
  3. 如果可以解析 Gemini 金鑰，則為 `gemini`。
  4. 如果可以解析 Voyage 金鑰，則為 `voyage`。
  5. 否則，記憶體搜尋保持停用狀態，直到設定完成。
- 本機模式使用 node-llama-cpp，可能需要 `pnpm approve-builds`。
- 使用 sqlite-vec（可用時）加速 SQLite 內的向量搜尋。

遠端嵌入**需要**嵌入供應商的 API 金鑰。OpenClaw 從憑證設定檔、`models.providers.*.apiKey` 或環境變數解析金鑰。Codex OAuth 僅涵蓋聊天/補全，**不**滿足記憶體搜尋的嵌入。對於 Gemini，使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。對於 Voyage，使用 `VOYAGE_API_KEY` 或 `models.providers.voyage.apiKey`。使用自訂 OpenAI 相容端點時，請設定 `memorySearch.remote.apiKey`（以及選用的 `memorySearch.remote.headers`）。

### QMD 後端 (實驗性)

設定 `memory.backend = "qmd"` 將內建的 SQLite 索引器替換為 [QMD](https://github.com/tobi/qmd)：一個結合 BM25 + 向量 + 重新排序的本機優先搜尋邊車。Markdown 仍是事實的來源；OpenClaw 會呼叫 QMD 進行檢索。主要重點：

**先決條件**

- 預設停用。在每個設定中選擇啟用 (`memory.backend = "qmd"`)。
- 分開安裝 QMD CLI (`bun install -g https://github.com/tobi/qmd` 或下載發行版) 並確保 `qmd` 二進位檔位於 Gateway 的 `PATH` 中。
- QMD 需要允許擴充功能的 SQLite 版本（在 macOS 上為 `brew install sqlite`）。
- QMD 完全在本機透過 Bun + `node-llama-cpp` 運行，並在首次使用時自動從 HuggingFace 下載 GGUF 模型（無需單獨的 Ollama 守護程式）。
- Gateway 在 `~/.openclaw/agents/<agentId>/qmd/` 下設定 `XDG_CONFIG_HOME` 和 `XDG_CACHE_HOME`，在自包含的 XDG 主目錄中運行 QMD。
- 作業系統支援：macOS 和 Linux 在安裝 Bun + SQLite 後即可直接使用。Windows 最好透過 WSL2 支援。

**邊車如何運行**

- Gateway 在 `~/.openclaw/agents/<agentId>/qmd/` 下寫入一個自包含的 QMD 主目錄（設定 + 快取 + sqlite 資料庫）。
- 集合透過 `qmd collection add` 從 `memory.qmd.paths`（加上預設工作區記憶體檔案）建立，然後 `qmd update` + `qmd embed` 在啟動時和可設定的時間間隔（`memory.qmd.update.interval`，預設 5 分鐘）運行。
- Gateway 現在在啟動時初始化 QMD 管理器，因此即使在第一次 `memory_search` 呼叫之前，也會啟動定期更新計時器。
- 啟動重新整理現在預設在背景運行，因此聊天啟動不會被阻塞；設定 `memory.qmd.update.waitForBootSync = true` 以保留之前的阻塞行為。
- 搜尋透過 `memory.qmd.searchMode` 運行（預設 `qmd query --json`；也支援 `search` 和 `vsearch`）。如果所選模式在您的 QMD 版本上拒絕標誌，OpenClaw 會使用 `qmd query` 重試。如果 QMD 失敗或二進位檔遺失，OpenClaw 會自動回退到內建的 SQLite 管理器，因此記憶體工具仍然可以工作。
- OpenClaw 目前不公開 QMD 嵌入批次大小調整；批次行為由 QMD 本身控制。
- **首次搜尋可能會很慢**：QMD 可能會在第一次 `qmd query` 運行時下載本機 GGUF 模型（重新排序器/查詢擴展）。
  - OpenClaw 在運行 QMD 時會自動設定 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 如果您想手動預下載模型（並預熱 OpenClaw 使用的相同索引），請使用智慧代理的 XDG 目錄運行一次性查詢。

    OpenClaw 的 QMD 狀態位於您的 **狀態目錄**（預設為 `~/.openclaw`）下。
    您可以透過匯出 OpenClaw 使用的相同 XDG 變數，將 `qmd` 指向完全相同的索引：

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**設定介面 (`memory.qmd.*`)**

- `command` (預設 `qmd`)：覆寫執行檔路徑。
- `searchMode` (預設 `query`)：選擇哪個 QMD 指令支援 `memory_search` (`query`, `search`, `vsearch`)。
- `includeDefaultMemory` (預設 `true`)：自動索引 `MEMORY.md` + `memory/**/*.md`。
- `paths[]`：添加額外的目錄/檔案 (`path`，選用 `pattern`，選用穩定 `name`)。
- `sessions`：選擇啟用工作階段 JSONL 索引 (`enabled`、`retentionDays`、`exportDir`)。
- `update`：控制重新整理頻率和維護執行：
  (`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、
  `commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`)。
- `limits`：限制召回負載 (`maxResults`、`maxSnippetChars`、
  `maxInjectedChars`、`timeoutMs`)。
- `scope`：與 [`session.sendPolicy`](/gateway/configuration#session) 相同的結構。
  預設為僅限私訊 (`deny` 所有，`allow` 直接聊天)；放寬它以在群組/頻道中顯示 QMD 命中。
- 當 `scope` 拒絕搜尋時，OpenClaw 會記錄帶有派生 `channel`/`chatType` 的警告，以便更容易偵錯空結果。
- 源自工作區外部的程式碼片段在 `memory_search` 結果中顯示為
  `qmd/<collection>/<relative-path>`；`memory_get` 理解該前綴並從已設定的 QMD 集合根目錄讀取。
- 當 `memory.qmd.sessions.enabled = true` 時，OpenClaw 會將經過淨化的工作階段紀錄 (使用者/助理回合) 匯出到 `~/.openclaw/agents/<id>/qmd/sessions/` 下的專用 QMD 集合中，因此 `memory_search` 可以召回最近的對話，而無需觸及內建的 SQLite 索引。
- `memory_search` 程式碼片段現在包含 `Source: <path#line>` 頁腳，當
  `memory.citations` 為 `auto`/`on` 時；設定 `memory.citations = "off"` 以保持
  路徑中繼資料在內部（智慧代理仍會收到 `memory_get` 的路徑，但程式碼片段文字會省略頁腳，且系統提示會警告智慧代理不要引用它）。

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

**引用和回退**

- `memory.citations` 無論後端如何都適用 (`auto`/`on`/`off`)。
- 當 `qmd` 運行時，我們標記 `status().backend = "qmd"`，以便診斷顯示哪個
  引擎提供了結果。如果 QMD 子程序退出或 JSON 輸出無法
  解析，搜尋管理器會記錄警告並返回內建提供商
  （現有的 Markdown 嵌入），直到 QMD 恢復。

### 額外的記憶體路徑

如果您想索引預設工作區佈局之外的 Markdown 檔案，請添加明確的路徑：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

注意：

- 路徑可以是絕對路徑或相對於工作區的路徑。
- 目錄會遞迴掃描 `.md` 檔案。
- 僅索引 Markdown 檔案。
- 符號連結（檔案或目錄）將被忽略。

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

注意：

- `remote.baseUrl` 是選用（預設為 Gemini API 的基本 URL）。
- `remote.headers` 讓您可以根據需要添加額外的標頭。
- 預設模型：`gemini-embedding-001`。

如果您想使用**自訂 OpenAI 相容端點**（OpenRouter、vLLM 或代理），
您可以使用帶有 OpenAI 供應商的 `remote` 設定：

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

如果您不想設定 API 金鑰，請使用 `memorySearch.provider = "local"` 或設定
`memorySearch.fallback = "none"`。

回退：

- `memorySearch.fallback` 可以是 `openai`、`gemini`、`local` 或 `none`。
- 回退供應商僅在主要嵌入供應商失敗時使用。

批次索引 (OpenAI + Gemini + Voyage)：

- 預設停用。設定 `agents.defaults.memorySearch.remote.batch.enabled = true` 以啟用大型語料庫索引 (OpenAI、Gemini 和 Voyage)。
- 預設行為會等待批次完成；如果需要，請調整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 和 `remote.batch.timeoutMinutes`。
- 設定 `remote.batch.concurrency` 以控制我們並行提交多少批次工作（預設：2）。
- 批次模式在 `memorySearch.provider = "openai"` 或 `"gemini"` 時適用，並使用相應的 API 金鑰。
- Gemini 批次工作使用非同步嵌入批次端點，並需要 Gemini 批次 API 的可用性。

為什麼 OpenAI 批次快速又便宜：

- 對於大型回填，OpenAI 通常是我們支援的最快選項，因為我們可以在單個批次工作中提交許多嵌入請求，並讓 OpenAI 非同步處理它們。
- OpenAI 為批次 API 工作負載提供折扣定價，因此大型索引運行通常比同步發送相同請求更便宜。
- 有關詳細資訊，請參閱 OpenAI 批次 API 文件和定價：
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

- `memory_search` — 返回帶有檔案 + 行範圍的程式碼片段。
- `memory_get` — 透過路徑讀取記憶體檔案內容。

本機模式：

- 設定 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath` (GGUF 或 `hf:` URI)。
- 選用：設定 `agents.defaults.memorySearch.fallback = "none"` 以避免遠端回退。

### 記憶體工具如何運作

- `memory_search` 會語義搜尋來自 `MEMORY.md` + `memory/**/*.md` 的 Markdown 區塊（目標約 400 token，重疊 80 token）。它會返回程式碼片段文字（上限約 700 字元）、檔案路徑、行範圍、分數、供應商/模型，以及我們是否從本機回退到遠端嵌入。不返回完整的檔案負載。
- `memory_get` 讀取特定的記憶體 Markdown 檔案（相對於工作區），可選從起始行和 N 行讀取。`MEMORY.md` / `memory/` 之外的路徑將被拒絕。
- 這兩個工具僅在 `memorySearch.enabled` 對智慧代理解析為 true 時才啟用。

### 什麼內容會被索引 (以及何時)

- 檔案類型：僅 Markdown (`MEMORY.md`, `memory/**/*.md`)。
- 索引儲存：每個智慧代理一個 SQLite，位於 `~/.openclaw/memory/<agentId>.sqlite`（可透過 `agents.defaults.memorySearch.store.path` 設定，支援 `{agentId}` token）。
- 新鮮度：`MEMORY.md` + `memory/` 的監測器會將索引標記為已更改（防抖動 1.5 秒）。同步會安排在工作階段開始時、搜尋時或間隔時，並非同步運行。工作階段紀錄使用差異閾值觸發背景同步。
- 重新索引觸發器：索引儲存嵌入**供應商/模型 + 端點指紋 + 分塊參數**。如果其中任何一個發生更改，OpenClaw 會自動重置並重新索引整個儲存。

### 混合搜尋 (BM25 + 向量)

啟用時，OpenClaw 會結合：

- **向量相似度**（語義匹配，措辭可能不同）
- **BM25 關鍵字相關性**（ID、環境變數、程式碼符號等確切 token）

如果您的平台上沒有全文搜尋，OpenClaw 會回退到僅限向量的搜尋。

#### 為何選擇混合搜尋？

向量搜尋非常擅長「這意味著相同的事情」：

- 「Mac Studio Gateway 主機」與「運行 Gateway 的機器」
- 「防抖動檔案更新」與「避免在每次寫入時進行索引」

但它在確切、高訊號 token 方面可能較弱：

- ID (`a828e60`、`b3b9895a...`)
- 程式碼符號 (`memorySearch.query.hybrid`)
- 錯誤字串（「sqlite-vec 無法使用」）

BM25（全文）則相反：擅長確切 token，在解釋上較弱。
混合搜尋是務實的折衷方案：**同時使用兩種檢索訊號**，以便在「自然語言」查詢和「大海撈針」查詢中都能獲得良好的結果。

#### 我們如何合併結果 (目前的設計)

實作草圖：

1. 從兩邊檢索候選池：

- **向量**：透過餘弦相似度選取前 `maxResults * candidateMultiplier` 個。
- **BM25**：透過 FTS5 BM25 等級選取前 `maxResults * candidateMultiplier` 個（越低越好）。

2. 將 BM25 等級轉換為約 0..1 的分數：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 透過區塊 ID 合併候選項目並計算加權分數：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注意：

- `vectorWeight` + `textWeight` 在設定解析中正規化為 1.0，因此權重表現為百分比。
- 如果嵌入不可用（或供應商返回零向量），我們仍然會運行 BM25 並返回關鍵字匹配。
- 如果無法建立 FTS5，我們將保留僅限向量的搜尋（沒有硬性失敗）。

這並非「IR 理論完美」，但它簡單、快速，並且往往能改善真實筆記的召回率/準確度。
如果我們以後想做得更精巧，常見的下一步是倒數排名融合（RRF）或分數正規化（min/max 或 Z 分數），然後再混合。

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

OpenClaw 可以在 SQLite 中快取**區塊嵌入**，這樣重新索引和頻繁更新（尤其是工作階段紀錄）就不會重新嵌入未更改的文字。

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

您可以選擇索引**工作階段紀錄**並透過 `memory_search` 顯示它們。
這受到一個實驗性標誌的限制。

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

注意：

- 工作階段索引是**選擇加入**（預設為關閉）。
- 工作階段更新會進行防抖動處理，並在超過差異閾值後**非同步索引**（盡力而為）。
- `memory_search` 永遠不會因索引而阻塞；結果可能會略微過時，直到背景同步完成。
- 結果仍然只包含程式碼片段；`memory_get` 仍然僅限於記憶體檔案。
- 工作階段索引是每個智慧代理獨立的（僅索引該智慧代理的工作階段日誌）。
- 工作階段日誌儲存在磁碟上 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)。任何具有檔案系統存取權限的程序/使用者都可以讀取它們，因此請將磁碟存取視為信任邊界。為了更嚴格的隔離，請在單獨的作業系統使用者或主機下運行智慧代理。

差異閾值（顯示預設值）：

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite 向量加速 (sqlite-vec)

當 sqlite-vec 擴充功能可用時，OpenClaw 會將嵌入儲存在 SQLite 虛擬表格 (`vec0`) 中，並在資料庫中執行向量距離查詢。這使得搜尋速度快，而無需將每個嵌入載入到 JS 中。

設定 (選用)：

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

注意：

- `enabled` 預設為 true；停用時，搜尋會回退到儲存嵌入的進程內餘弦相似度。
- 如果 sqlite-vec 擴充功能遺失或無法載入，OpenClaw 會記錄錯誤並繼續使用 JS 回退（無向量表格）。
- `extensionPath` 會覆寫綁定的 sqlite-vec 路徑（對於自訂建置或非標準安裝位置很有用）。

### 本機嵌入自動下載

- 預設本機嵌入模型：`hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf`（約 0.6 GB）。
- 當 `memorySearch.provider = "local"` 時，`node-llama-cpp` 會解析 `modelPath`；如果 GGUF 遺失，它會**自動下載**到快取（如果設定了 `local.modelCacheDir`，則下載到該目錄），然後載入它。下載會在重試時恢復。
- 原生建置要求：運行 `pnpm approve-builds`，選擇 `node-llama-cpp`，然後 `pnpm rebuild node-llama-cpp`。
- 回退：如果本機設定失敗且 `memorySearch.fallback = "openai"`，我們會自動切換到遠端嵌入（`openai/text-embedding-3-small`，除非被覆寫）並記錄原因。

### 自訂 OpenAI 相容端點範例

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

注意：

- `remote.*` 優先於 `models.providers.openai.*`。
- `remote.headers` 會與 OpenAI 標頭合併；遠端在金鑰衝突時勝出。省略 `remote.headers` 以使用 OpenAI 預設值。
