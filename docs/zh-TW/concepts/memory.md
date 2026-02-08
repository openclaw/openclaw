---
summary: 「OpenClaw 記憶體的運作方式（工作區檔案＋自動記憶體清空）」
read_when:
  - 「你想了解記憶體檔案配置與工作流程」
  - 「你想調校自動預先壓縮的記憶體清空」
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:27Z
---

# Memory

OpenClaw 記憶體是 **代理程式工作區中的純 Markdown**。這些檔案是
唯一可信來源；模型只會「記住」寫入磁碟的內容。

記憶體搜尋工具由目前啟用的記憶體外掛提供（預設：
`memory-core`）。可使用 `plugins.slots.memory = "none"` 停用記憶體外掛。

## Memory files（Markdown）

預設的工作區配置使用兩層記憶體：

- `memory/YYYY-MM-DD.md`
  - 每日紀錄（僅追加）。
  - 工作階段開始時讀取今天＋昨天。
- `MEMORY.md`（選用）
  - 精選的長期記憶。
  - **僅在主要、私人工作階段載入**（絕不在群組情境中）。

這些檔案位於工作區之下（`agents.defaults.workspace`，預設為
`~/.openclaw/workspace`）。完整配置請參見 [Agent workspace](/concepts/agent-workspace)。

## 何時寫入記憶體

- 決策、偏好與可長期保存的事實寫入 `MEMORY.md`。
- 日常筆記與進行中的脈絡寫入 `memory/YYYY-MM-DD.md`。
- 若有人說「記住這個」，就把它寫下來（不要只放在 RAM）。
- 這個區域仍在演進中。提醒模型儲存記憶會有幫助；它知道該怎麼做。
- 若你希望某件事能留下來，**請要求機器人把它寫入** 記憶體。

## 自動記憶體清空（預先壓縮 ping）

當工作階段 **接近自動壓縮** 時，OpenClaw 會觸發一個 **無聲、
具代理性的回合**，在內容被壓縮 **之前** 提醒模型寫入可長期保存的記憶。
預設提示明確表示模型 _可以回覆_，但通常 `NO_REPLY` 才是正確回應，
因此使用者不會看到這個回合。

此行為由 `agents.defaults.compaction.memoryFlush` 控制：

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

詳細說明：

- **軟性門檻**：當工作階段的權杖數估計值跨過
  `contextWindow - reserveTokensFloor - softThresholdTokens` 時觸發清空。
- **預設為無聲**：提示包含 `NO_REPLY`，因此不會送達使用者。
- **兩個提示**：使用者提示＋系統提示一併附加提醒。
- **每個壓縮循環僅一次清空**（於 `sessions.json` 追蹤）。
- **工作區必須可寫入**：若工作階段以沙箱模式執行且使用
  `workspaceAccess: "ro"` 或 `"none"`，則會略過清空。

完整的壓縮生命週期請見
[Session management + compaction](/reference/session-management-compaction)。

## 向量記憶搜尋

OpenClaw 可以在 `MEMORY.md` 與 `memory/*.md` 上建立小型向量索引，
使語意查詢即使措辭不同也能找到相關筆記。

預設值：

- 預設啟用。
- 監看記憶體檔案變更（去抖動）。
- 預設使用遠端嵌入。若未設定 `memorySearch.provider`，OpenClaw 會自動選擇：
  1. 若設定了 `memorySearch.local.modelPath` 且檔案存在，使用 `local`。
  2. 若可解析 OpenAI 金鑰，使用 `openai`。
  3. 若可解析 Gemini 金鑰，使用 `gemini`。
  4. 若可解析 Voyage 金鑰，使用 `voyage`。
  5. 否則在完成設定前，記憶搜尋會維持停用。
- 本地模式使用 node-llama-cpp，且可能需要 `pnpm approve-builds`。
- 可用時使用 sqlite-vec 以加速 SQLite 內的向量搜尋。

遠端嵌入 **需要** 嵌入提供者的 API 金鑰。OpenClaw 會從驗證設定檔、
`models.providers.*.apiKey` 或環境變數解析金鑰。Codex OAuth 僅涵蓋聊天／完成，
**不** 能滿足記憶搜尋的嵌入需求。Gemini 請使用 `GEMINI_API_KEY` 或
`models.providers.google.apiKey`；Voyage 請使用 `VOYAGE_API_KEY` 或
`models.providers.voyage.apiKey`。使用自訂的 OpenAI 相容端點時，請設定
`memorySearch.remote.apiKey`（以及選用的 `memorySearch.remote.headers`）。

### QMD 後端（實驗性）

設定 `memory.backend = "qmd"` 以將內建的 SQLite 索引器替換為
[QMD](https://github.com/tobi/qmd)：一個以本地為優先的搜尋側車，結合
BM25＋向量＋重新排序。Markdown 仍是唯一可信來源；OpenClaw 透過殼層呼叫
QMD 進行擷取。重點如下：

**先決條件**

- 預設停用。需於每個設定中選擇加入（`memory.backend = "qmd"`）。
- 需另行安裝 QMD CLI（`bun install -g https://github.com/tobi/qmd` 或下載
  發行版），並確保 `qmd` 二進位檔位於 Gateway 閘道器的
  `PATH`。
- QMD 需要允許擴充的 SQLite 建置（macOS 使用 `brew install sqlite`）。
- QMD 透過 Bun＋`node-llama-cpp` 完全在本地執行，並在首次使用時
  從 HuggingFace 自動下載 GGUF 模型（不需要獨立的 Ollama 常駐程式）。
- Gateway 閘道器 會在
  `~/.openclaw/agents/<agentId>/qmd/` 下設定 `XDG_CONFIG_HOME` 與
  `XDG_CACHE_HOME`，於自成一體的 XDG home 中執行 QMD。
- 作業系統支援：安裝好 Bun＋SQLite 後，macOS 與 Linux 可即用。
  Windows 最佳方式為 WSL2。

**側車的執行方式**

- Gateway 閘道器 會在
  `~/.openclaw/agents/<agentId>/qmd/` 下寫入自成一體的 QMD home（設定＋快取＋ sqlite DB）。
- 透過 `qmd collection add` 從 `memory.qmd.paths`
  （加上預設的工作區記憶體檔案）建立集合，接著在開機與可設定的間隔
  （`memory.qmd.update.interval`，預設 5 m）執行 `qmd update`＋`qmd embed`。
- 開機時的重新整理現在預設在背景執行，避免阻塞聊天啟動；設定
  `memory.qmd.update.waitForBootSync = true` 可保留先前的阻塞行為。
- 搜尋透過 `qmd query --json` 執行。若 QMD 失敗或缺少二進位檔，
  OpenClaw 會自動回退至內建的 SQLite 管理器，確保記憶工具可繼續運作。
- OpenClaw 目前未提供 QMD 的嵌入批次大小調校；批次行為由 QMD 本身控制。
- **首次搜尋可能較慢**：QMD 可能在第一次 `qmd query` 執行時
  下載本地 GGUF 模型（重新排序／查詢擴展）。
  - OpenClaw 在執行 QMD 時會自動設定 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 若要手動預先下載模型（並暖身與 OpenClaw 相同的索引），
    請使用代理程式的 XDG 目錄執行一次性查詢。

    OpenClaw 的 QMD 狀態位於你的 **狀態目錄**（預設為 `~/.openclaw`）。
    你可以匯出 OpenClaw 使用的相同 XDG 變數，將 `qmd` 指向完全相同的索引：

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

**設定介面（`memory.qmd.*`）**

- `command`（預設 `qmd`）：覆寫可執行檔路徑。
- `includeDefaultMemory`（預設 `true`）：自動索引 `MEMORY.md`＋`memory/**/*.md`。
- `paths[]`：新增額外目錄／檔案（`path`，選用 `pattern`，選用
  穩定的 `name`）。
- `sessions`：選擇加入工作階段 JSONL 索引（`enabled`、`retentionDays`、
  `exportDir`）。
- `update`：控制重新整理頻率與維護執行：
  （`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、
  `commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`）。
- `limits`：限制回憶負載（`maxResults`、`maxSnippetChars`、
  `maxInjectedChars`、`timeoutMs`）。
- `scope`：與 [`session.sendPolicy`](/gateway/configuration#session) 相同的結構描述。
  預設僅限私訊（`deny` 全部、`allow` 直接聊天）；放寬後可在群組／頻道中顯示 QMD 命中。
- 來自工作區外的片段會以
  `qmd/<collection>/<relative-path>` 顯示於 `memory_search` 結果中；`memory_get`
  會理解該前綴並從設定的 QMD 集合根目錄讀取。
- 當 `memory.qmd.sessions.enabled = true` 時，OpenClaw 會將已去識別化的工作階段逐字稿
  （使用者／助理回合）匯出到
  `~/.openclaw/agents/<id>/qmd/sessions/` 下的專用 QMD 集合，讓 `memory_search` 能回憶近期
  對話而不需觸碰內建的 SQLite 索引。
- 當 `memory.citations` 為 `auto`/`on` 時，
  `memory_search` 片段現在會包含 `Source: <path#line>` 頁尾；設定
  `memory.citations = "off"` 可將路徑中繼資料保留為內部（代理程式仍會收到路徑以用於
  `memory_get`，但片段文字會省略頁尾，且系統提示會警告代理程式不要引用）。

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

- `memory.citations` 不論後端為何皆適用（`auto`/`on`/`off`）。
- 當 `qmd` 執行時，我們會標記 `status().backend = "qmd"`，
  讓診斷顯示是哪個引擎提供結果。若 QMD 子行程結束或 JSON 輸出無法解析，
  搜尋管理器會記錄警告並回傳內建提供者（既有的 Markdown 嵌入），直到 QMD 恢復。

### 其他記憶體路徑

若要索引預設工作區配置之外的 Markdown 檔案，請新增明確路徑：

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

- 路徑可為絕對路徑或相對於工作區。
- 目錄會遞迴掃描 `.md` 檔案。
- 僅索引 Markdown 檔案。
- 忽略符號連結（檔案或目錄）。

### Gemini 嵌入（原生）

將提供者設定為 `gemini` 以直接使用 Gemini 嵌入 API：

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

- `remote.baseUrl` 為選用（預設為 Gemini API 基底 URL）。
- `remote.headers` 可在需要時新增額外標頭。
- 預設模型：`gemini-embedding-001`。

若要使用 **自訂的 OpenAI 相容端點**（OpenRouter、vLLM 或代理），
可搭配 OpenAI 提供者使用 `remote` 設定：

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

若不想設定 API 金鑰，請使用 `memorySearch.provider = "local"` 或設定
`memorySearch.fallback = "none"`。

回退：

- `memorySearch.fallback` 可為 `openai`、`gemini`、`local` 或 `none`。
- 回退提供者僅在主要嵌入提供者失敗時使用。

批次索引（OpenAI＋Gemini）：

- OpenAI 與 Gemini 嵌入預設啟用。設定 `agents.defaults.memorySearch.remote.batch.enabled = false` 可停用。
- 預設行為會等待批次完成；必要時可調整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 與 `remote.batch.timeoutMinutes`。
- 設定 `remote.batch.concurrency` 以控制並行提交的批次工作數量（預設：2）。
- 當 `memorySearch.provider = "openai"` 或 `"gemini"` 時會套用批次模式，並使用對應的 API 金鑰。
- Gemini 批次工作使用非同步嵌入批次端點，且需要 Gemini Batch API 可用。

為何 OpenAI 批次又快又便宜：

- 對於大型回填，OpenAI 通常是我們支援中最快的選項，因為可在單一批次工作中提交大量嵌入請求，並讓 OpenAI 非同步處理。
- OpenAI 為 Batch API 工作負載提供折扣定價，因此大型索引通常比同步送出相同請求更便宜。
- 詳情請參見 OpenAI Batch API 文件與價格：
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

- `memory_search` — 回傳包含檔案＋行範圍的片段。
- `memory_get` — 依路徑讀取記憶體檔案內容。

本地模式：

- 設定 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath`（GGUF 或 `hf:` URI）。
- 選用：設定 `agents.defaults.memorySearch.fallback = "none"` 以避免遠端回退。

### 記憶工具如何運作

- `memory_search` 會對來自 `MEMORY.md`＋`memory/**/*.md` 的 Markdown 區塊
  進行語意搜尋（目標約 400 權杖、80 權杖重疊）。它會回傳片段文字（上限約 700 字元）、
  檔案路徑、行範圍、分數、提供者／模型，以及是否從本地→遠端嵌入回退。
  不會回傳完整檔案內容。
- `memory_get` 會讀取特定的記憶體 Markdown 檔案（相對於工作區），
  可選擇指定起始行與行數。位於 `MEMORY.md`／`memory/` 之外的路徑會被拒絕。
- 兩個工具僅在代理程式的 `memorySearch.enabled` 解析為 true 時啟用。

### 會被索引的內容（以及時機）

- 檔案類型：僅 Markdown（`MEMORY.md`、`memory/**/*.md`）。
- 索引儲存：每個代理程式一個 SQLite，位於 `~/.openclaw/memory/<agentId>.sqlite`
  （可透過 `agents.defaults.memorySearch.store.path` 設定，支援 `{agentId}` 權杖）。
- 新鮮度：監看 `MEMORY.md`＋`memory/`，將索引標記為髒（去抖 1.5 秒）。
  同步會在工作階段開始、搜尋時或定期排程並以非同步方式執行。
  工作階段逐字稿使用差量門檻來觸發背景同步。
- 重新索引觸發：索引會儲存嵌入 **提供者／模型＋端點指紋＋分塊參數**。
  只要其中任一變更，OpenClaw 會自動重設並重新索引整個儲存區。

### 混合搜尋（BM25＋向量）

啟用時，OpenClaw 會結合：

- **向量相似度**（語意匹配，措辭可不同）
- **BM25 關鍵字關聯性**（精確權杖，如 ID、環境變數、程式碼符號）

若平台不支援全文搜尋，OpenClaw 會回退為僅向量搜尋。

#### 為何要混合？

向量搜尋很擅長「意思相同」：

- 「Mac Studio gateway host」vs「執行 Gateway 閘道器 的機器」
- 「去抖檔案更新」vs「避免每次寫入就索引」

但對於精確且高訊號的權杖較弱：

- ID（`a828e60`、`b3b9895a…`）
- 程式碼符號（`memorySearch.query.hybrid`）
- 錯誤字串（「sqlite-vec unavailable」）

BM25（全文）則相反：精確權杖很強，轉述較弱。
混合搜尋是務實的折衷：**同時使用兩種擷取訊號**，
兼顧「自然語言」與「大海撈針」的查詢。

#### 我們如何合併結果（目前設計）

實作草圖：

1. 從兩側各自擷取候選池：

- **向量**：依餘弦相似度取前 `maxResults * candidateMultiplier`。
- **BM25**：依 FTS5 BM25 排名取前 `maxResults * candidateMultiplier`（數值越低越好）。

2. 將 BM25 排名轉為近似 0..1 的分數：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 以區塊 ID 合併候選並計算加權分數：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注意事項：

- `vectorWeight`＋`textWeight` 於設定解析時正規化為 1.0，
  因此權重行為等同百分比。
- 若嵌入不可用（或提供者回傳零向量），仍會執行 BM25 並回傳關鍵字匹配。
- 若無法建立 FTS5，則保留僅向量搜尋（不會硬性失敗）。

這不是「IR 理論上的完美」，但簡單、快速，且在實際筆記上通常能提升召回率／精準度。
未來若要更進階，常見的下一步是 Reciprocal Rank Fusion（RRF）或
在混合前進行分數正規化（最小／最大或 z-score）。

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

OpenClaw 可在 SQLite 中快取 **區塊嵌入**，讓重新索引與頻繁更新
（尤其是工作階段逐字稿）不必為未變更的文字重新嵌入。

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

### 工作階段記憶搜尋（實驗性）

你可以選擇索引 **工作階段逐字稿**，並透過 `memory_search` 顯示。
此功能受實驗旗標控管。

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

- 工作階段索引為 **選擇加入**（預設關閉）。
- 工作階段更新會去抖，並在跨過差量門檻後 **非同步索引**（盡力而為）。
- `memory_search` 從不等待索引完成；在背景同步完成前，結果可能略為過時。
- 結果仍僅包含片段；`memory_get` 仍僅限記憶體檔案。
- 工作階段索引為每個代理程式隔離（只索引該代理程式的工作階段紀錄）。
- 工作階段紀錄會存於磁碟（`~/.openclaw/agents/<agentId>/sessions/*.jsonl`）。任何具有檔案系統存取權的程序／使用者都可讀取，
  因此請將磁碟存取視為信任邊界。若需更嚴格隔離，請以不同 OS 使用者或主機執行代理程式。

差量門檻（顯示預設值）：

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

### SQLite 向量加速（sqlite-vec）

當 sqlite-vec 擴充可用時，OpenClaw 會將嵌入儲存在
SQLite 虛擬表（`vec0`）中，並在資料庫內執行向量距離查詢。
這能在不將每個嵌入載入到 JS 的情況下保持搜尋效能。

設定（選用）：

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

- `enabled` 預設為 true；停用時，搜尋會回退為在處理序內
  對已儲存嵌入進行餘弦相似度計算。
- 若 sqlite-vec 擴充缺失或載入失敗，OpenClaw 會記錄錯誤並以 JS 回退繼續
  （不使用向量表）。
- `extensionPath` 可覆寫隨附的 sqlite-vec 路徑（適用於自訂建置
  或非標準安裝位置）。

### 本地嵌入自動下載

- 預設本地嵌入模型：`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`（約 0.6 GB）。
- 當 `memorySearch.provider = "local"` 時，`node-llama-cpp` 會解析 `modelPath`；
  若缺少 GGUF，會 **自動下載** 至快取（或設定的 `local.modelCacheDir`），
  然後載入。下載可在重試時續傳。
- 原生建置需求：執行 `pnpm approve-builds`，選擇 `node-llama-cpp`，
  接著 `pnpm rebuild node-llama-cpp`。
- 回退：若本地設定失敗且 `memorySearch.fallback = "openai"`，我們會自動切換至遠端嵌入
  （除非覆寫，預設為 `openai/text-embedding-3-small`），並記錄原因。

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

注意事項：

- `remote.*` 的優先順序高於 `models.providers.openai.*`。
- `remote.headers` 會與 OpenAI 標頭合併；發生金鑰衝突時以遠端為準。
  省略 `remote.headers` 可使用 OpenAI 的預設值。
