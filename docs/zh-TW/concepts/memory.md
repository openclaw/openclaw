---
title: Memory
summary: How OpenClaw memory works (workspace files + automatic memory flush)
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---

# 記憶

OpenClaw 的記憶是 **代理工作區中的純 Markdown**。這些檔案是事實的來源；模型只「記得」寫入磁碟的內容。

記憶搜尋工具由啟用中的記憶外掛提供（預設為 `memory-core`）。可用 `plugins.slots.memory = "none"` 停用記憶外掛。

## 記憶檔案（Markdown）

預設的工作區佈局使用兩層記憶：

- `memory/YYYY-MM-DD.md`
  - 每日記錄（僅附加）。
  - 在會話開始時讀取今天和昨天的內容。
- `MEMORY.md`（可選）
  - 精選的長期記憶。
  - **僅在主要私人會話中載入**（群組環境中絕不載入）。

這些檔案位於工作區底下（`agents.defaults.workspace`，預設為 `~/.openclaw/workspace`）。完整佈局請參考 [代理工作區](/concepts/agent-workspace)。

## 記憶工具

OpenClaw 提供兩個面向代理的工具來操作這些 Markdown 檔案：

- `memory_search` — 對已索引片段的語意回想。
- `memory_get` — 針對特定 Markdown 檔案/行範圍的精準讀取。

`memory_get` 現在 **在檔案不存在時會優雅降級**（例如，首次寫入前的今日每日記錄）。內建管理器和 QMD 後端會回傳 `{ text: "", path }`，而非拋出 `ENOENT`，讓代理能處理「尚無紀錄」的狀況，並繼續工作流程，無需在工具呼叫時包裹 try/catch。

## 何時寫入記憶

- 決策、偏好和持久事實寫入 `MEMORY.md`。
- 日常筆記和持續上下文寫入 `memory/YYYY-MM-DD.md`。
- 若有人說「記住這個」，就寫下來（不要只存在記憶體中）。
- 這部分仍在演進中。提醒模型儲存記憶會有幫助；它會知道該怎麼做。
- 若想讓資訊持久，**請求機器人將其寫入記憶**。

## 自動記憶刷新（壓縮前提醒）

當會話 **接近自動壓縮時**，OpenClaw 會觸發一個 **靜默且代理式的回合**，提醒模型在上下文被壓縮 **之前** 寫入持久記憶。預設提示明確表示模型 _可能會回應_，但通常 `NO_REPLY` 是正確回應，使用者不會看到這個回合。

這是由 `agents.defaults.compaction.memoryFlush` 控制：

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

詳細資訊：

- **軟性閾值**：當會話 token 預估值超過 `contextWindow - reserveTokensFloor - softThresholdTokens` 時觸發 flush。
- 預設為 **靜默**：提示包含 `NO_REPLY`，因此不會輸出任何內容。
- **兩個提示**：一個使用者提示加上一個系統提示，附加提醒內容。
- 每個壓縮週期只執行一次 flush（在 `sessions.json` 中追蹤）。
- **工作區必須可寫入**：如果會話在沙盒環境中執行，且使用了 `workspaceAccess: "ro"` 或 `"none"`，則會跳過 flush。

完整的壓縮生命週期，請參考
[會話管理 + 壓縮](/reference/session-management-compaction)。

## 向量記憶搜尋

OpenClaw 可以針對 `MEMORY.md` 和 `memory/*.md` 建立一個小型向量索引，
讓語意查詢即使用詞不同也能找到相關筆記。

預設設定：

- 預設啟用。
- 監控記憶檔案變更（有防抖機制）。
- 在 `agents.defaults.memorySearch` 下設定記憶搜尋（非頂層的 `memorySearch`）。
- 預設使用遠端 embeddings。如果未設定 `memorySearch.provider`，OpenClaw 會自動選擇：
  1. 如果設定且檔案存在，使用 `local` 的 `memorySearch.local.modelPath`。
  2. 如果能解析 OpenAI 金鑰，使用 `openai`。
  3. 如果能解析 Gemini 金鑰，使用 `gemini`。
  4. 如果能解析 Voyage 金鑰，使用 `voyage`。
  5. 如果能解析 Mistral 金鑰，使用 `mistral`。
  6. 否則記憶搜尋會保持停用，直到設定完成。
- 本地模式使用 node-llama-cpp，可能需要 `pnpm approve-builds`。
- 使用 sqlite-vec（若可用）加速 SQLite 內的向量搜尋。
- `memorySearch.provider = "ollama"` 也支援本地/自架設的 Ollama embeddings（`/api/embeddings`），但不會自動選擇。

遠端 embeddings **需要** 提供者的 API 金鑰。OpenClaw 從認證設定檔、`models.providers.*.apiKey` 或環境變數中解析金鑰。Codex OAuth 僅涵蓋聊天/補全，**不**適用於記憶搜尋的 embeddings。Gemini 使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。Voyage 使用 `VOYAGE_API_KEY` 或 `models.providers.voyage.apiKey`。Mistral 使用 `MISTRAL_API_KEY` 或 `models.providers.mistral.apiKey`。Ollama 通常不需要真實 API 金鑰（本地政策需要時，像 `OLLAMA_API_KEY=ollama-local` 這類佔位符即可）。使用自訂 OpenAI 相容端點時，設定 `memorySearch.remote.apiKey`（及可選的 `memorySearch.remote.headers`）。

### QMD 後端（實驗性）

設定 `memory.backend = "qmd"` 以替換內建 SQLite 索引器為
[QMD](https://github.com/tobi/qmd)：一個以本地為主的搜尋輔助工具，結合 BM25 + 向量 + 重排序。Markdown 仍是唯一真實資料來源；OpenClaw 會呼叫 QMD 進行檢索。重點如下：

**前置條件**

- 預設停用。需在設定中選擇啟用（`memory.backend = "qmd"`）。
- 需另行安裝 QMD CLI（`bun install -g https://github.com/tobi/qmd` 或下載發行版），並確保 `qmd` 執行檔在 gateway 的 `PATH` 中。
- QMD 需要支援擴充功能的 SQLite 版本（macOS 上為 `brew install sqlite`）。
- QMD 完全本地執行，透過 Bun + `node-llama-cpp`，首次使用時會自動從 HuggingFace 下載 GGUF 模型（不需額外的 Ollama 守護程序）。
- gateway 透過設定 `XDG_CONFIG_HOME` 和 `XDG_CACHE_HOME`，在 `~/.openclaw/agents/<agentId>/qmd/` 下以自包含的 XDG home 執行 QMD。
- 作業系統支援：macOS 和 Linux 安裝 Bun + SQLite 後即可使用。Windows 最佳支援為 WSL2。

**sidecar 運作方式**

- Gateway 會在 `~/.openclaw/agents/<agentId>/qmd/` 下建立一個自包含的 QMD 主目錄（包含設定檔、快取與 sqlite 資料庫）。
- 集合是透過 `qmd collection add` 從 `memory.qmd.paths`（加上預設的工作區記憶體檔案）建立，接著 `qmd update` 與 `qmd embed` 會在啟動時及可設定的間隔時間（`memory.qmd.update.interval`，預設 5 分鐘）執行。
- Gateway 現在會在啟動時初始化 QMD 管理器，因此即使在第一次 `memory_search` 呼叫之前，週期性更新計時器也會啟動。
- 啟動時的刷新現在預設在背景執行，避免阻塞聊天啟動；若要維持之前的阻塞行為，請設定 `memory.qmd.update.waitForBootSync = true`。
- 搜尋是透過 `memory.qmd.searchMode` 執行（預設為 `qmd search --json`；也支援 `vsearch` 與 `query`）。如果所選模式在你的 QMD 建置中拒絕標誌，OpenClaw 會改用 `qmd query` 重試。若 QMD 失敗或二進位檔缺失，OpenClaw 會自動回退到內建的 SQLite 管理器，確保記憶體工具持續運作。
- OpenClaw 目前不提供 QMD 嵌入批次大小的調整；批次行為由 QMD 自身控制。
- **首次搜尋可能較慢**：QMD 可能會在第一次 `qmd query` 執行時下載本地 GGUF 模型（重排序器/查詢擴充）。
  - OpenClaw 在執行 QMD 時會自動設定 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 若你想手動預先下載模型（並預熱 OpenClaw 使用的相同索引），可使用代理的 XDG 目錄執行一次查詢。

OpenClaw 的 QMD 狀態存放於你的 **狀態目錄**（預設為 `~/.openclaw`）。
你可以透過匯出 OpenClaw 使用的相同 XDG 變數，將 `qmd` 指向完全相同的索引：

bash # 選擇 OpenClaw 使用的相同狀態目錄
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

# （可選）強制索引刷新與嵌入

    qmd update
    qmd embed

# 預熱 / 觸發首次模型下載

    qmd query "test" -c memory-root --json >/dev/null 2>&1

**設定介面 (`memory.qmd.*`)**

- `command`（預設 `qmd`）：覆寫執行檔路徑。
- `searchMode`（預設 `search`）：選擇支援 `memory_search` 的 QMD 指令（`search`、`vsearch`、`query`）。
- `includeDefaultMemory`（預設 `true`）：自動索引 `MEMORY.md` 與 `memory/**/*.md`。
- `paths[]`：新增額外目錄/檔案（`path`，可選 `pattern`，可選穩定版 `name`）。
- `sessions`：選擇加入會話 JSONL 索引（`enabled`、`retentionDays`、`exportDir`）。
- `update`：控制刷新頻率與維護執行（`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、`commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`）。
- `limits`：限制召回負載（`maxResults`、`maxSnippetChars`、`maxInjectedChars`、`timeoutMs`）。
- `scope`：與 [`session.sendPolicy`](/gateway/configuration#session) 相同的結構。預設僅限 DM（`deny` 全部，`allow` 直接聊天）；可放寬以在群組/頻道中顯示 QMD 命中結果。
  - `match.keyPrefix` 匹配 **正規化** 的會話鍵（小寫，並移除任何前導 `agent:<id>:`）。範例：`discord:channel:`。
  - `match.rawKeyPrefix` 匹配 **原始** 會話鍵（小寫），包含 `agent:<id>:`。範例：`agent:main:discord:`。
  - 傳統：`match.keyPrefix: "agent:..."` 仍視為原始鍵前綴，但建議使用 `rawKeyPrefix` 以提高清晰度。
- 當 `scope` 拒絕搜尋時，OpenClaw 會記錄帶有推導出 `channel`/`chatType` 的警告，方便除錯空結果。
- 來自工作區外的片段會在 `memory_search` 結果中顯示為 `qmd/<collection>/<relative-path>`；`memory_get` 會識別該前綴並從設定的 QMD 集合根目錄讀取。
- 當 `memory.qmd.sessions.enabled = true` 時，OpenClaw 會將淨化過的會話記錄（使用者/助理對話）匯出到 `~/.openclaw/agents/<id>/qmd/sessions/` 下的專用 QMD 集合，讓 `memory_search` 能在不觸及內建 SQLite 索引的情況下召回近期對話。
- `memory_search` 片段在 `memory.citations` 為 `auto`/`on` 時，會包含 `Source: <path#line>` 頁尾；設定 `memory.citations = "off"` 可將路徑元資料保留為內部資訊（代理仍會收到用於 `memory_get` 的路徑，但片段文字會省略頁尾，系統提示會警告代理不要引用它）。

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
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        // Normalized session-key prefix (strips `agent:<id>:`).
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // Raw session-key prefix (includes `agent:<id>:`).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**引用與回退**

- `memory.citations` 不論後端（`auto`/`on`/`off`）皆適用。
- 當 `qmd` 執行時，我們會標記 `status().backend = "qmd"`，以便診斷顯示是哪個引擎提供結果。若 QMD 子程序退出或 JSON 輸出無法解析，搜尋管理器會記錄警告並回傳內建提供者（現有 Markdown 嵌入），直到 QMD 恢復。

### 額外的記憶體路徑

若你想索引預設工作區佈局外的 Markdown 檔案，請新增明確路徑：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

說明：

- 路徑可以是絕對路徑或工作區相對路徑。
- 目錄會遞迴掃描 `.md` 檔案。
- 預設只會索引 Markdown 檔案。
- 若啟用 `memorySearch.multimodal.enabled = true`，OpenClaw 也會索引 `extraPaths` 下支援的圖片/音訊檔案。預設的記憶根目錄 (`MEMORY.md`、`memory.md`、`memory/**/*.md`) 仍維持只索引 Markdown。
- 符號連結（檔案或目錄）會被忽略。

### 多模態記憶檔案（Gemini 圖片 + 音訊）

OpenClaw 在使用 Gemini embedding 2 時，可以索引來自 `memorySearch.extraPaths` 的圖片和音訊檔案：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: ["assets/reference", "voice-notes"],
      multimodal: {
        enabled: true,
        modalities: ["image", "audio"], // or ["all"]
        maxFileBytes: 10000000
      },
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

說明：

- 多模態記憶目前僅支援 `gemini-embedding-2-preview`。
- 多模態索引只適用於透過 `memorySearch.extraPaths` 發現的檔案。
- 此階段支援的模態為圖片和音訊。
- 啟用多模態記憶時，`memorySearch.fallback` 必須保持 `"none"`。
- 索引期間，符合的圖片/音訊檔案位元組會上傳至設定的 Gemini embedding 端點。
- 支援的圖片副檔名：`.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.heic`、`.heif`。
- 支援的音訊副檔名：`.mp3`、`.wav`、`.ogg`、`.opus`、`.m4a`、`.aac`、`.flac`。
- 搜尋查詢仍為文字，但 Gemini 可將文字查詢與已索引的圖片/音訊嵌入向量做比對。
- `memory_get` 仍只讀取 Markdown；二進位檔案可被搜尋，但不會以原始檔案內容回傳。

### Gemini 嵌入（原生）

將提供者設定為 `gemini`，即可直接使用 Gemini embeddings API：

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

說明：

- `remote.baseUrl` 為選填（預設為 Gemini API 基底 URL）。
- `remote.headers` 可用來額外添加標頭（headers）。
- 預設模型為 `gemini-embedding-001`。
- 也支援 `gemini-embedding-2-preview`：8192 token 限制，且維度可設定（768 / 1536 / 3072，預設為 3072）。

#### Gemini Embedding 2（預覽）

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 3072,  // optional: 768, 1536, or 3072 (default)
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

> **⚠️ 需重新索引：** 從 `gemini-embedding-001`（768 維度）
> 切換到 `gemini-embedding-2-preview`（3072 維度）會改變向量大小。若更改 `outputDimensionality` 為 768、1536 或 3072 也同理。
> OpenClaw 偵測到模型或維度變更時會自動重新索引。

如果您想使用 **自訂的 OpenAI 相容端點**（OpenRouter、vLLM 或代理），
可以使用 OpenAI 提供者的 `remote` 設定：

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

備援方案：

- `memorySearch.fallback` 可以是 `openai`、`gemini`、`voyage`、`mistral`、`ollama`、`local` 或 `none`。
- 備援提供者僅在主要嵌入提供者失敗時使用。

批次索引（OpenAI + Gemini + Voyage）：

- 預設為停用。設定 `agents.defaults.memorySearch.remote.batch.enabled = true` 以啟用大型語料庫索引（OpenAI、Gemini 和 Voyage）。
- 預設行為會等待批次完成；如有需要，可調整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 和 `remote.batch.timeoutMinutes`。
- 設定 `remote.batch.concurrency` 以控制同時提交多少批次工作（預設：2）。
- 批次模式適用於 `memorySearch.provider = "openai"` 或 `"gemini"`，並使用對應的 API 金鑰。
- Gemini 批次工作使用非同步嵌入批次端點，需 Gemini 批次 API 可用。

為什麼 OpenAI 批次快速且便宜：

- 對於大型回填，OpenAI 通常是我們支援中最快的選項，因為我們可以在單一批次工作中提交多個嵌入請求，並讓 OpenAI 非同步處理。
- OpenAI 對批次 API 工作負載提供折扣價格，因此大型索引作業通常比同步送出相同請求更便宜。
- 詳情請參考 OpenAI 批次 API 文件與價格：
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

- `memory_search` — 回傳包含檔案與行範圍的程式碼片段。
- `memory_get` — 透過路徑讀取記憶體檔案內容。

本地模式：

- 設定 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath`（GGUF 或 `hf:` URI）。
- 選用：設定 `agents.defaults.memorySearch.fallback = "none"` 以避免遠端備援。

### 記憶工具的運作方式

- `memory_search` 會從 `MEMORY.md` + `memory/**/*.md` 中語意搜尋 Markdown 片段（目標約 400 個 token，重疊 80 token）。它會回傳片段文字（限制約 700 字元）、檔案路徑、行數範圍、分數、提供者/模型，以及是否從本地嵌入降級到遠端嵌入。並不會回傳完整檔案內容。
- `memory_get` 會讀取特定的記憶 Markdown 檔案（相對於工作區），可選擇從起始行開始讀取 N 行。路徑若不在 `MEMORY.md` / `memory/` 範圍內則會被拒絕。
- 這兩個工具僅在 `memorySearch.enabled` 對代理回傳 true 時啟用。

### 索引內容（以及時間點）

- 檔案類型：僅限 Markdown (`MEMORY.md`, `memory/**/*.md`)。
- 索引儲存：每個代理使用 SQLite，位置在 `~/.openclaw/memory/<agentId>.sqlite`（可透過 `agents.defaults.memorySearch.store.path` 設定，支援 `{agentId}` token）。
- 新鮮度：監控 `MEMORY.md` + `memory/`，若有變動會標記索引為髒（防抖 1.5 秒）。同步會在會話開始、搜尋時或定時排程非同步執行。會話記錄會用差異閾值觸發背景同步。
- 重新索引觸發條件：索引會儲存嵌入的 **提供者/模型 + 端點指紋 + 分段參數**。若其中任一變更，OpenClaw 會自動重置並重新索引整個資料庫。

### 混合搜尋（BM25 + 向量）

啟用時，OpenClaw 會結合：

- **向量相似度**（語意匹配，措辭可不同）
- **BM25 關鍵字相關性**（精確 token，如 ID、環境變數、程式碼符號）

若您的平台無法使用全文搜尋，OpenClaw 會退回使用純向量搜尋。

#### 為什麼要混合？

向量搜尋擅長「這兩者意思相同」的情況：

- 「Mac Studio gateway host」與「執行 gateway 的機器」
- 「防抖檔案更新」與「避免每次寫入都索引」

但它在精確且高訊號的 token 上可能較弱：

- ID (`a828e60`, `b3b9895a…`)
- 程式碼符號 (`memorySearch.query.hybrid`)
- 錯誤字串（例如 "sqlite-vec unavailable"）

BM25（全文）則相反：擅長精確 token，對同義改寫較弱。
混合搜尋是務實的中間路線：**同時使用兩種檢索訊號**，讓您在「自然語言」查詢和「大海撈針」查詢都能得到良好結果。

#### 我們如何合併結果（目前設計）

實作草圖：

1. 從雙方擷取候選池：

- **向量**：依餘弦相似度取前 `maxResults * candidateMultiplier` 名。
- **BM25**：依 FTS5 BM25 排名取前 `maxResults * candidateMultiplier` 名（分數越低越好）。

2. 將 BM25 排名轉換為約 0..1 的分數：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 以區塊 ID 合併候選，並計算加權分數：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

備註：

- `vectorWeight` + `textWeight` 在設定解析時會正規化為 1.0，因此權重表現為百分比。
- 若無法取得 embeddings（或提供者回傳零向量），仍會執行 BM25 並回傳關鍵字匹配結果。
- 若無法建立 FTS5，則維持僅向量搜尋（不會造成嚴重錯誤）。

這並非「資訊檢索理論上的完美方案」，但簡單快速，且在實際筆記中通常能提升召回率與精確度。
若日後想要更進階，常見的下一步是使用互惠排名融合（Reciprocal Rank Fusion, RRF）或在混合前做分數正規化（最小/最大值或 z 分數）。

#### 後處理流程

在合併向量與關鍵字分數後，有兩個可選的後處理階段
用以在結果送出給代理前進一步優化：

```
Vector + Keyword → Weighted Merge → Temporal Decay → Sort → MMR → Top-K Results
```

兩個階段預設皆為**關閉**，可獨立啟用。

#### MMR 重新排序（多樣性）

當混合搜尋返回結果時，可能會有多個片段包含相似或重疊的內容。
例如，搜尋「家庭網路設定」可能會返回五個幾乎相同的片段，
這些片段來自不同的每日筆記，且都提到相同的路由器設定。

**MMR（最大邊際相關性）** 會重新排序結果，以平衡相關性與多樣性，
確保前幾名結果涵蓋查詢的不同面向，而非重複相同資訊。

運作方式：

1. 結果依原始相關性分數（向量 + BM25 加權分數）進行評分。
2. MMR 透過迭代選擇最大化：`λ × relevance − (1−λ) × max_similarity_to_selected` 的結果。
3. 結果間的相似度使用斷詞後的 Jaccard 文字相似度來衡量。

`lambda` 參數控制此權衡：

- `lambda = 1.0` → 純相關性（不考慮多樣性懲罰）
- `lambda = 0.0` → 最大多樣性（忽略相關性）
- 預設值：`0.7`（平衡，稍偏向相關性）

**範例 — 查詢：「家庭網路設定」**

給定這些記憶檔案：

```
memory/2026-02-10.md  → "Configured Omada router, set VLAN 10 for IoT devices"
memory/2026-02-08.md  → "Configured Omada router, moved IoT to VLAN 10"
memory/2026-02-05.md  → "Set up AdGuard DNS on 192.168.10.2"
memory/network.md     → "Router: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

未使用 MMR — 前 3 名結果：

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/2026-02-08.md  (score: 0.89)  ← router + VLAN (near-duplicate!)
3. memory/network.md     (score: 0.85)  ← reference doc
```

使用 MMR（λ=0.7）— 前 3 名結果：

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/network.md     (score: 0.85)  ← reference doc (diverse!)
3. memory/2026-02-05.md  (score: 0.78)  ← AdGuard DNS (diverse!)
```

2 月 8 日的近重複結果被剔除，代理人獲得三個不同的資訊片段。

**何時啟用：** 如果你發現 `memory_search` 返回冗餘或近重複的片段，
尤其是每日筆記中常跨日重複類似資訊時。

#### 時間衰減（近期加權）

擁有每日筆記的代理人會隨著時間累積數百個帶日期的檔案。若沒有衰減機制，
六個月前寫得很好的筆記可能會勝過昨天針對同一主題的更新。

**時間衰減**會根據每個結果的年齡，對分數套用指數乘數，
讓近期的記憶自然排名較高，而舊的則逐漸淡出：

```
decayedScore = score × e^(-λ × ageInDays)
```

其中 `λ = ln(2) / halfLifeDays`。

以預設的半衰期 30 天為例：

- 今天的筆記：原始分數的 **100%**
- 7 天前：約 **84%**
- 30 天前：**50%**
- 90 天前：**12.5%**
- 180 天前：約 **1.6%**

**常青檔案永遠不會衰減：**

- `MEMORY.md`（根記憶檔案）
- `memory/` 中的非日期檔案（例如 `memory/projects.md`、`memory/network.md`）
- 這些包含持久的參考資訊，應該始終保持正常排名。

**帶日期的每日檔案**（`memory/YYYY-MM-DD.md`）使用從檔名擷取的日期。
其他來源（例如會話記錄）則退而求其次使用檔案修改時間（`mtime`）。

**範例 — 查詢：「Rod 的工作時間表是什麼？」**

給定這些記憶檔案（今天是 2 月 10 日）：

```
memory/2025-09-15.md  → "Rod works Mon-Fri, standup at 10am, pairing at 2pm"  (148 days old)
memory/2026-02-10.md  → "Rod has standup at 14:15, 1:1 with Zeb at 14:45"    (today)
memory/2026-02-03.md  → "Rod started new team, standup moved to 14:15"        (7 days old)
```

若無衰減：

```
1. memory/2025-09-15.md  (score: 0.91)  ← best semantic match, but stale!
2. memory/2026-02-10.md  (score: 0.82)
3. memory/2026-02-03.md  (score: 0.80)
```

使用衰減（halfLife=30）：

```
1. memory/2026-02-10.md  (score: 0.82 × 1.00 = 0.82)  ← today, no decay
2. memory/2026-02-03.md  (score: 0.80 × 0.85 = 0.68)  ← 7 days, mild decay
3. memory/2025-09-15.md  (score: 0.91 × 0.03 = 0.03)  ← 148 days, nearly gone
```

即使擁有最佳的原始語意匹配，過時的九月筆記仍會掉到底部。

**何時啟用：** 如果你的代理擁有數月的每日筆記，且發現舊的、過時的資訊排名高於近期內容。對於以每日筆記為主的工作流程，半衰期設為30天效果良好；如果你經常參考較舊的筆記，可以將其調高（例如90天）。

#### 設定

兩項功能皆在 `memorySearch.query.hybrid` 下設定：

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // Diversity: reduce redundant results
          mmr: {
            enabled: true,    // default: false
            lambda: 0.7       // 0 = max diversity, 1 = max relevance
          },
          // Recency: boost newer memories
          temporalDecay: {
            enabled: true,    // default: false
            halfLifeDays: 30  // score halves every 30 days
          }
        }
      }
    }
  }
}
```

你可以獨立啟用任一功能：

- **僅 MMR** — 適用於有大量相似筆記但不在意時間因素的情況。
- **僅時間衰減** — 適用於重視新近性但結果已經多樣化的情況。
- **兩者皆啟用** — 建議用於擁有龐大且長期運作的每日筆記歷史的代理。

### 向量快取

OpenClaw 可以將**區塊向量**快取於 SQLite 中，避免重新索引和頻繁更新（尤其是會話記錄）時，對未變更的文字重複產生向量。

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

### 會話記憶搜尋（實驗性）

你可以選擇索引**會話記錄**，並透過 `memory_search` 顯示它們。此功能需透過實驗性旗標啟用。

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

- 會話索引為**選擇性啟用**（預設關閉）。
- 會話更新會經過去抖動，並在超過差異閾值後**非同步索引**（盡力而為）。
- `memory_search` 不會因索引而阻塞；結果可能會稍微過時，直到背景同步完成。
- 結果仍只包含片段；`memory_get` 仍限於記憶體檔案。
- 會話索引是針對每個代理隔離（只索引該代理的會話日誌）。
- 會話日誌存放於磁碟 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)。任何擁有檔案系統存取權限的程序/使用者都能讀取，因此請將磁碟存取視為信任邊界。若需更嚴格隔離，請在不同的作業系統使用者或主機下執行代理。

差異閾值（預設值）：

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

當 sqlite-vec 擴充功能可用時，OpenClaw 會將嵌入向量存放在 SQLite 虛擬資料表 (`vec0`)，並在資料庫中執行向量距離查詢。這樣可以保持搜尋速度快速，無需將所有嵌入向量載入 JS。

設定（可選）：

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

- `enabled` 預設為 true；若停用，搜尋會退回到在程序內對已存嵌入向量執行餘弦相似度計算。
- 若缺少 sqlite-vec 擴充功能或載入失敗，OpenClaw 會記錄錯誤並繼續使用 JS 退回方案（無向量資料表）。
- `extensionPath` 可覆寫內建的 sqlite-vec 路徑（適用於自訂編譯或非標準安裝位置）。

### 本地嵌入向量自動下載

- 預設本地嵌入模型：`hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf`（約 0.6 GB）。
- 當 `memorySearch.provider = "local"` 時，`node-llama-cpp` 會解析 `modelPath`；若 GGUF 檔案缺失，會**自動下載**到快取（或設定的 `local.modelCacheDir`），然後載入。下載可在重試時繼續。
- 原生建置需求：執行 `pnpm approve-builds`，選擇 `node-llama-cpp`，接著 `pnpm rebuild node-llama-cpp`。
- 備援方案：若本地設定失敗且 `memorySearch.fallback = "openai"`，我們會自動切換到遠端嵌入向量（除非被覆寫，預設為 `openai/text-embedding-3-small`）並記錄原因。

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

說明：

- `remote.*` 優先於 `models.providers.openai.*`。
- `remote.headers` 與 OpenAI 標頭合併；若有鍵衝突，以遠端為準。省略 `remote.headers` 則使用 OpenAI 預設值。
