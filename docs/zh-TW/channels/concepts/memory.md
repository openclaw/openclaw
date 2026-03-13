---
title: Memory
summary: How OpenClaw memory works (workspace files + automatic memory flush)
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---

# Memory

OpenClaw 的記憶是 **代理工作區中的純 Markdown**。這些檔案是事實的來源；模型僅「記住」寫入磁碟的內容。

記憶體搜尋工具由活躍的記憶體插件提供（預設：`memory-core`）。使用 `plugins.slots.memory = "none"` 禁用記憶體插件。

## Memory files (Markdown)

預設的工作區佈局使用兩個記憶體層：

- `memory/YYYY-MM-DD.md`
  - 每日記錄（僅附加）。
  - 在會話開始時讀取今天和昨天的記錄。
- `MEMORY.md` (可選)
  - 精選的長期記憶。
  - **僅在主要的私人會話中載入**（絕不在群組上下文中）。

這些檔案位於工作區 (`agents.defaults.workspace`，預設 `~/.openclaw/workspace`)。請參閱 [代理工作區](/concepts/agent-workspace) 以獲取完整佈局。

## Memory tools

OpenClaw 提供了兩個面向代理的工具來處理這些 Markdown 檔案：

- `memory_search` — 對索引片段的語意回憶。
- `memory_get` — 針對特定 Markdown 檔案/行範圍的目標讀取。

`memory_get` 現在在 **檔案不存在時優雅降級**（例如，今天的日誌在第一次寫入之前）。內建管理器和 QMD 後端都返回 `{ text: "", path }` 而不是拋出 `ENOENT`，因此代理可以處理「尚未記錄任何內容」的情況，並在不需要將工具調用包裹在 try/catch 邏輯中的情況下繼續其工作流程。

## 何時寫入記憶體

- 決策、偏好和持久事實放入 `MEMORY.md`。
- 日常筆記和持續上下文放入 `memory/YYYY-MM-DD.md`。
- 如果有人說「記住這個」，請寫下來（不要保存在 RAM 中）。
- 這個區域仍在發展中。提醒模型儲存記憶是有幫助的；它會知道該怎麼做。
- 如果你希望某件事能夠保留，**請要求機器人將其寫入記憶**。

## 自動記憶體清除（預壓縮 ping）

當一個會話**接近自動壓縮**時，OpenClaw 會觸發一個**靜默的、代理的轉變**，提醒模型在上下文被壓縮**之前**寫入持久記憶。預設的提示明確表示模型*可能會回覆*，但通常 `NO_REPLY` 是正確的回應，因此使用者從未看到這個轉變。

這是由 `agents.defaults.compaction.memoryFlush` 控制的：

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

[[BLOCK_1]]

- **軟閾值**：當會話token估算值超過 `contextWindow - reserveTokensFloor - softThresholdTokens` 時觸發 flush。
- **預設為靜默**：提示包含 `NO_REPLY`，因此不會傳送任何內容。
- **兩個提示**：用戶提示加上系統提示附加提醒。
- **每個壓縮週期僅一次 flush**（在 `sessions.json` 中追蹤）。
- **工作區必須可寫**：如果會話在 `workspaceAccess: "ro"` 或 `"none"` 中以沙盒模式執行，則會跳過 flush。

有關完整的壓縮生命週期，請參閱 [Session management + compaction](/reference/session-management-compaction)。

## 向量記憶體搜尋

OpenClaw 可以在 `MEMORY.md` 和 `memory/*.md` 上建立一個小型向量索引，以便語意查詢即使在措辭不同的情況下也能找到相關的筆記。

Defaults:

- 預設啟用。
- 監控記憶體檔案的變更（去抖動）。
- 在 `agents.defaults.memorySearch` 下設定記憶體搜尋（而非頂層 `memorySearch`）。
- 預設使用遠端嵌入。如果 `memorySearch.provider` 未設定，OpenClaw 會自動選擇：
  1. `local` 如果已設定 `memorySearch.local.modelPath` 且檔案存在。
  2. `openai` 如果可以解析 OpenAI 金鑰。
  3. `gemini` 如果可以解析 Gemini 金鑰。
  4. `voyage` 如果可以解析 Voyage 金鑰。
  5. `mistral` 如果可以解析 Mistral 金鑰。
  6. 否則記憶體搜尋將保持禁用，直到設定完成。
- 本地模式使用 node-llama-cpp，可能需要 `pnpm approve-builds`。
- 使用 sqlite-vec（當可用時）來加速 SQLite 內的向量搜尋。
- `memorySearch.provider = "ollama"` 也支援本地/自我託管的 Ollama 嵌入 (`/api/embeddings`)，但不會自動選擇。

遠端嵌入 **需要** 嵌入提供者的 API 金鑰。OpenClaw 從認證設定檔、`models.providers.*.apiKey` 或環境變數中解析金鑰。Codex OAuth 僅涵蓋聊天/完成，並不滿足記憶搜尋的嵌入需求。對於 Gemini，使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。對於 Voyage，使用 `VOYAGE_API_KEY` 或 `models.providers.voyage.apiKey`。對於 Mistral，使用 `MISTRAL_API_KEY` 或 `models.providers.mistral.apiKey`。Ollama 通常不需要真正的 API 金鑰（當地政策需要時，像 `OLLAMA_API_KEY=ollama-local` 這樣的佔位符就足夠了）。使用自訂的 OpenAI 相容端點時，設置 `memorySearch.remote.apiKey`（以及可選的 `memorySearch.remote.headers`）。

### QMD 後端（實驗性）

將 `memory.backend = "qmd"` 設定為替換內建的 SQLite 索引器為 [QMD](https://github.com/tobi/qmd)：一個本地優先的搜尋側邊程式，結合了 BM25 + 向量 + 重新排序。Markdown 仍然是事實的來源；OpenClaw 將檢索外包給 QMD。關鍵點：

**前置條件**

- 預設為禁用。需按設定選擇啟用 (`memory.backend = "qmd"`)。
- 單獨安裝 QMD CLI (`bun install -g https://github.com/tobi/qmd` 或下載一個版本)，並確保 `qmd` 二進位檔位於網關的 `PATH` 上。
- QMD 需要一個允許擴充的 SQLite 版本 (`brew install sqlite` 在 macOS 上)。
- QMD 完全在本地執行，透過 Bun + `node-llama-cpp`，並在首次使用時自動從 HuggingFace 下載 GGUF 模型（不需要單獨的 Ollama 守護進程）。
- 網關在 `~/.openclaw/agents/<agentId>/qmd/` 下的自包含 XDG 主目錄中執行 QMD，通過設置 `XDG_CONFIG_HOME` 和 `XDG_CACHE_HOME`。
- 作業系統支援：macOS 和 Linux 在安裝 Bun + SQLite 後可即時使用。Windows 最佳支援透過 WSL2。

**側車如何執行**

- 閘道器在 `~/.openclaw/agents/<agentId>/qmd/` 下寫入一個自包含的 QMD 主目錄（設定 + 快取 + sqlite 資料庫）。
- 集合是通過 `qmd collection add` 從 `memory.qmd.paths` 創建的（加上預設的工作區記憶體檔案），然後 `qmd update` + `qmd embed` 在啟動時和可設定的間隔 (`memory.qmd.update.interval`，預設為 5 分鐘) 執行。
- 閘道器現在在啟動時初始化 QMD 管理器，因此即使在第一次 `memory_search` 呼叫之前，定期更新計時器也會被啟動。
- 啟動刷新現在預設在背景中執行，因此聊天啟動不會被阻塞；設置 `memory.qmd.update.waitForBootSync = true` 以保持先前的阻塞行為。
- 搜索通過 `memory.qmd.searchMode` 執行（預設為 `qmd search --json`；也支援 `vsearch` 和 `query`）。如果所選模式在您的 QMD 構建中拒絕標誌，OpenClaw 將使用 `qmd query` 進行重試。如果 QMD 失敗或二進位檔案缺失，OpenClaw 會自動回退到內建的 SQLite 管理器，以便記憶體工具繼續運作。
- OpenClaw 今天不公開 QMD 嵌入批次大小調整；批次行為由 QMD 本身控制。
- **第一次搜索可能會很慢**：QMD 可能會在第一次 `qmd query` 執行時下載本地 GGUF 模型（重排序/查詢擴充）。
  - OpenClaw 在執行 QMD 時自動設置 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 如果您想手動預下載模型（並加載 OpenClaw 使用的相同索引），請使用代理的 XDG 目錄執行一次性查詢。

OpenClaw 的 QMD 狀態位於您的 **state dir** 下（預設為 `~/.openclaw`）。  
您可以通過匯出相同的 XDG 變數，將 `qmd` 指向完全相同的索引，OpenClaw 使用這些變數：

bash # 選擇 OpenClaw 使用的相同狀態目錄
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

# (可選) 強制更新索引 + 嵌入

    qmd update
    qmd embed

# 暖身 / 觸發首次模型下載

    qmd query "test" -c memory-root --json >/dev/null 2>&1

**設定表面 (`memory.qmd.*`)**

- `command` (預設 `qmd`): 覆蓋可執行檔路徑。
- `searchMode` (預設 `search`): 選擇哪個 QMD 命令支援 `memory_search` (`search`, `vsearch`, `query`)。
- `includeDefaultMemory` (預設 `true`): 自動索引 `MEMORY.md` + `memory/**/*.md`。
- `paths[]`: 添加額外的目錄/檔案 (`path`, 可選 `pattern`, 可選穩定 `name`)。
- `sessions`: 選擇會話 JSONL 索引 (`enabled`, `retentionDays`, `exportDir`)。
- `update`: 控制刷新頻率和維護執行：
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)。
- `limits`: 限制回憶有效載荷 (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`)。
- `scope`: 與 [`session.sendPolicy`](/gateway/configuration#session) 相同的架構。
  預設為僅 DM (`deny` 全部, `allow` 直接聊天)；放寬限制以在群組/頻道中顯示 QMD 命中。
  - `match.keyPrefix` 匹配 **標準化** 的會話鍵（小寫，去除任何前導 `agent:<id>:`）。範例: `discord:channel:`。
  - `match.rawKeyPrefix` 匹配 **原始** 的會話鍵（小寫），包括 `agent:<id>:`。範例: `agent:main:discord:`。
  - 遺留: `match.keyPrefix: "agent:..."` 仍然被視為原始鍵前綴，但為了清晰起見，建議使用 `rawKeyPrefix`。
- 當 `scope` 拒絕搜尋時，OpenClaw 會記錄一個警告，並附上衍生的 `channel`/`chatType`，以便更容易調試空結果。
- 來自工作區外的片段會顯示為 `qmd/<collection>/<relative-path>` 在 `memory_search` 結果中；`memory_get` 理解該前綴並從設定的 QMD 集合根讀取。
- 當 `memory.qmd.sessions.enabled = true` 時，OpenClaw 將清理過的會話記錄（用戶/助手回合）匯出到 `~/.openclaw/agents/<id>/qmd/sessions/` 下的專用 QMD 集合中，以便 `memory_search` 可以回憶最近的對話，而無需觸及內建的 SQLite 索引。
- `memory_search` 片段現在在 `memory.citations` 為 `auto`/`on` 時包含 `Source: <path#line>` 頁腳；設置 `memory.citations = "off"` 以保持路徑元數據內部（代理仍然接收 `memory_get` 的路徑，但片段文本省略頁腳，系統提示警告代理不要引用它）。

**Example**

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

**引用與後備**

- `memory.citations` 適用於所有後端 (`auto`/`on`/`off`)。
- 當 `qmd` 執行時，我們標記 `status().backend = "qmd"`，以便診斷顯示哪個引擎提供了結果。如果 QMD 子進程退出或無法解析 JSON 輸出，搜尋管理器會記錄一個警告並返回內建提供者（現有的 Markdown 嵌入），直到 QMD 恢復。

### 其他記憶體路徑

如果您想要在預設工作區佈局之外索引 Markdown 檔案，請添加明確的路徑：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

[[BLOCK_1]]

- 路徑可以是絕對路徑或工作區相對路徑。
- 目錄會遞迴掃描 `.md` 檔案。
- 預設情況下，只有 Markdown 檔案會被索引。
- 如果 `memorySearch.multimodal.enabled = true`，OpenClaw 也會在 `extraPaths` 下索引支援的影像/音訊檔案。預設的記憶體根目錄 (`MEMORY.md`, `memory.md`, `memory/**/*.md`) 仍然僅限於 Markdown。
- 符號連結（檔案或目錄）會被忽略。

### 多模態記憶檔案 (Gemini 圖像 + 音訊)

OpenClaw 可以從 `memorySearch.extraPaths` 索引影像和音訊檔案，當使用 Gemini 嵌入 2 時：

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

[[BLOCK_1]]

- 異質記憶目前僅支援 `gemini-embedding-2-preview`。
- 異質索引僅適用於透過 `memorySearch.extraPaths` 發現的檔案。
- 此階段支援的模式：影像和音訊。
- `memorySearch.fallback` 必須保持 `"none"`，同時啟用異質記憶。
- 匹配的影像/音訊檔案位元組在索引過程中上傳至設定的 Gemini 嵌入端點。
- 支援的影像副檔名：`.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.heic`、`.heif`。
- 支援的音訊副檔名：`.mp3`、`.wav`、`.ogg`、`.opus`、`.m4a`、`.aac`、`.flac`。
- 搜尋查詢仍然是文字，但 Gemini 可以將這些文字查詢與已索引的影像/音訊嵌入進行比較。
- `memory_get` 仍然僅讀取 Markdown；二進位檔案可搜尋，但不會以原始檔案內容返回。

### Gemini 嵌入 (原生)

將提供者設置為 `gemini` 以直接使用 Gemini 嵌入 API：

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

[[BLOCK_1]]

- `remote.baseUrl` 是可選的（預設為 Gemini API 基本 URL）。
- `remote.headers` 讓你在需要時添加額外的標頭。
- 預設模型：`gemini-embedding-001`。
- `gemini-embedding-2-preview` 也受到支援：8192 token 限制和可設定的維度（768 / 1536 / 3072，預設為 3072）。

#### Gemini Embedding 2 (預覽)

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

> **⚠️ 需要重新索引：** 從 `gemini-embedding-001` (768 維) 切換到 `gemini-embedding-2-preview` (3072 維) 會改變向量大小。如果你在 768、1536 和 3072 之間更改 `outputDimensionality`，情況也是如此。當 OpenClaw 偵測到模型或維度變更時，將自動重新索引。

如果您想使用 **自訂的 OpenAI 相容端點**（OpenRouter、vLLM 或代理），您可以使用 `remote` 設定與 OpenAI 提供者一起使用：

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

如果您不想設置 API 金鑰，請使用 `memorySearch.provider = "local"` 或設置 `memorySearch.fallback = "none"`。

Fallbacks:

- `memorySearch.fallback` 可以是 `openai`、`gemini`、`voyage`、`mistral`、`ollama`、`local` 或 `none`。
- 當主要的嵌入提供者失敗時，才會使用備用提供者。

[[BLOCK_1]]  
批次索引 (OpenAI + Gemini + Voyage):  
[[BLOCK_1]]

- 預設為禁用。設置 `agents.defaults.memorySearch.remote.batch.enabled = true` 以啟用大語料庫索引（OpenAI、Gemini 和 Voyage）。
- 預設行為會等待批次完成；如有需要，調整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 和 `remote.batch.timeoutMinutes`。
- 設置 `remote.batch.concurrency` 以控制我們同時提交多少批次作業（預設：2）。
- 當 `memorySearch.provider = "openai"` 或 `"gemini"` 時，批次模式適用並使用相應的 API 金鑰。
- Gemini 批次作業使用非同步嵌入批次端點，並需要 Gemini 批次 API 可用性。

為什麼 OpenAI 批次處理又快又便宜：

- 對於大型回填，OpenAI 通常是我們支援的最快選擇，因為我們可以在單一批次作業中提交許多嵌入請求，並讓 OpenAI 進行非同步處理。
- OpenAI 為批次 API 工作負載提供折扣定價，因此大型索引執行通常比同步發送相同請求便宜。
- 有關詳細資訊，請參閱 OpenAI 批次 API 文檔和定價：
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Config example:

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

Tools:

- `memory_search` — 返回包含檔案 + 行範圍的片段。
- `memory_get` — 透過路徑讀取記憶體檔案內容。

Local mode:

- 設定 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath` (GGUF 或 `hf:` URI)。
- 可選：設定 `agents.defaults.memorySearch.fallback = "none"` 以避免遠端回退。

### 記憶工具的運作方式

- `memory_search` 進行語意搜尋 Markdown 區塊（目標約 400 個 token，重疊 80 個 token）來自 `MEMORY.md` + `memory/**/*.md`。它返回片段文本（限制約 700 個字元）、檔案路徑、行範圍、分數、提供者/模型，以及我們是否從本地嵌入回退到遠端嵌入。未返回完整的檔案負載。
- `memory_get` 讀取特定的記憶 Markdown 檔案（相對於工作區），可選擇從起始行開始並讀取 N 行。路徑在 `MEMORY.md` / `memory/` 之外的將被拒絕。
- 只有當 `memorySearch.enabled` 對代理解析為真時，兩個工具才會啟用。

### 什麼會被索引（以及何時）

- 檔案類型：僅限 Markdown (`MEMORY.md`, `memory/**/*.md`)。
- 索引儲存：每個代理的 SQLite 在 `~/.openclaw/memory/<agentId>.sqlite`（可透過 `agents.defaults.memorySearch.store.path` 設定，支援 `{agentId}` token）。
- 新鮮度：監視器在 `MEMORY.md` + `memory/` 標記索引為髒（去彈性 1.5 秒）。同步在會話開始時、搜尋時或在間隔內排程，並以非同步方式執行。會話記錄使用增量閾值來觸發背景同步。
- 重新索引觸發器：索引儲存嵌入 **提供者/模型 + 端點指紋 + 分塊參數**。如果其中任何一項變更，OpenClaw 會自動重置並重新索引整個儲存。

### 混合搜尋 (BM25 + 向量)

當啟用時，OpenClaw 結合：

- **向量相似度**（語意匹配，措辭可以不同）
- **BM25 關鍵字相關性**（精確的標記，如 ID、環境變數、程式碼符號）

如果您的平台上無法使用全文搜尋，OpenClaw 將退回到僅使用向量搜尋。

#### 為什麼選擇混合模式？

向量搜尋擅長於「這意味著相同的事情」：

- “Mac Studio gateway host” 與 “執行網關的機器”
- “去抖動檔案更新” 與 “避免在每次寫入時進行索引”

但在精確的高信號 token 上可能會較弱：

- IDs (`a828e60`, `b3b9895a…`)
- code symbols (`memorySearch.query.hybrid`)
- error strings ("sqlite-vec unavailable")

BM25（全文檢索）則相反：對於精確的標記表現強勁，但對於同義詞的表現較弱。混合搜尋則是務實的折衷方案：**同時使用兩種檢索信號**，這樣可以對「自然語言」查詢和「大海撈針」查詢都獲得良好的結果。

#### 我們如何合併結果（目前的設計）

實作草圖：

1. 從雙方獲取候選人名單：

- **向量**: 依據餘弦相似度排名的前 `maxResults * candidateMultiplier`。
- **BM25**: 依據 FTS5 BM25 排名的前 `maxResults * candidateMultiplier`（數值越低越好）。

2. 將 BM25 排名轉換為 0..1 的分數：

`textScore = 1 / (1 + max(0, bm25Rank))`

3. 根據區塊 ID 合併候選者並計算加權分數：

`finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notes:

- `vectorWeight` + `textWeight` 在設定解析度中被標準化為 1.0，因此權重的行為類似於百分比。
- 如果嵌入不可用（或提供者返回零向量），我們仍然執行 BM25 並返回關鍵字匹配。
- 如果無法創建 FTS5，我們將保持僅向量搜索（不會硬性失敗）。

這並不是「IR-理論完美」，但它簡單、快速，並且通常能改善真實筆記的召回率/精確度。如果我們想要在之後變得更複雜，常見的下一步是進行互惠排名融合（Reciprocal Rank Fusion, RRF）或在混合之前進行分數正規化（min/max 或 z-score）。

#### 後處理管道

在合併向量和關鍵字分數後，有兩個可選的後處理階段會在結果列表到達代理之前進行精煉：

```
Vector + Keyword → Weighted Merge → Temporal Decay → Sort → MMR → Top-K Results
```

兩個階段預設為 **關閉**，可以獨立啟用。

#### MMR 重新排序（多樣性）

當混合搜尋返回結果時，可能會有多個區塊包含相似或重疊的內容。例如，搜尋「家庭網路設定」可能會從不同的日常筆記中返回五個幾乎相同的片段，這些片段都提到相同的路由器設定。

**MMR (Maximal Marginal Relevance)** 重新排序結果，以平衡相關性與多樣性，確保頂部結果涵蓋查詢的不同面向，而不是重複相同的資訊。

如何運作：

1. 結果根據其原始相關性進行評分（向量 + BM25 加權分數）。
2. MMR 迭代選擇最大化的結果：`λ × relevance − (1−λ) × max_similarity_to_selected`。
3. 結果之間的相似性是使用基於標記內容的 Jaccard 文本相似度來衡量的。

`lambda` 參數控制著權衡：

- `lambda = 1.0` → 純相關性（無多樣性懲罰）
- `lambda = 0.0` → 最大多樣性（忽略相關性）
- 預設：`0.7`（平衡，輕微相關性偏向）

**範例 — 查詢： "家庭網路設置"**

給定這些記憶體檔案：

```
memory/2026-02-10.md  → "Configured Omada router, set VLAN 10 for IoT devices"
memory/2026-02-08.md  → "Configured Omada router, moved IoT to VLAN 10"
memory/2026-02-05.md  → "Set up AdGuard DNS on 192.168.10.2"
memory/network.md     → "Router: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

[[BLOCK_1]]  
無需 MMR — 前 3 名結果：  
[[BLOCK_1]]

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/2026-02-08.md  (score: 0.89)  ← router + VLAN (near-duplicate!)
3. memory/network.md     (score: 0.85)  ← reference doc
```

使用 MMR (λ=0.7) — 前 3 名結果：

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/network.md     (score: 0.85)  ← reference doc (diverse!)
3. memory/2026-02-05.md  (score: 0.78)  ← AdGuard DNS (diverse!)
```

從 2 月 8 日的近似重複專案消失，代理獲得三個不同的資訊。

**何時啟用：** 如果你注意到 `memory_search` 返回冗餘或近似重複的片段，特別是在每日筆記中，這些筆記經常在不同的日子重複類似的資訊。

#### 時間衰減（近期提升）

隨著時間的推移，擁有每日備註的代理人會累積數百個有日期的檔案。如果沒有衰減，六個月前的精心撰寫的備註可能會在同一主題上超越昨天的更新。

**時間衰減** 對每個結果的分數應用指數乘數，根據每個結果的年齡進行調整，因此最近的記憶自然排名較高，而舊的記憶則逐漸消退：

```
decayedScore = score × e^(-λ × ageInDays)
```

where `λ = ln(2) / halfLifeDays`.

使用預設的半衰期為 30 天：

- 今天的記錄：**100%** 的原始分數
- 7 天前：**~84%**
- 30 天前：**50%**
- 90 天前：**12.5%**
- 180 天前：**~1.6%**

**常青檔案永不衰退：**

- `MEMORY.md` (根記憶檔案)
- `memory/` 中的無日期檔案 (例如，`memory/projects.md`、`memory/network.md`)
- 這些檔案包含應始終正常排名的持久參考資訊。

**日期每日檔案** (`memory/YYYY-MM-DD.md`) 使用從檔名中提取的日期。其他來源（例如，會議記錄）則回退至檔案的修改時間 (`mtime`).

**範例 — 查詢： "Rod 的工作時間表是什麼？"**

給定這些記憶檔案（今天是2月10日）：

```
memory/2025-09-15.md  → "Rod works Mon-Fri, standup at 10am, pairing at 2pm"  (148 days old)
memory/2026-02-10.md  → "Rod has standup at 14:15, 1:1 with Zeb at 14:45"    (today)
memory/2026-02-03.md  → "Rod started new team, standup moved to 14:15"        (7 days old)
```

[[BLOCK_1]]

```
1. memory/2025-09-15.md  (score: 0.91)  ← best semantic match, but stale!
2. memory/2026-02-10.md  (score: 0.82)
3. memory/2026-02-03.md  (score: 0.80)
```

隨著衰變 (halfLife=30):

```
1. memory/2026-02-10.md  (score: 0.82 × 1.00 = 0.82)  ← today, no decay
2. memory/2026-02-03.md  (score: 0.80 × 0.85 = 0.68)  ← 7 days, mild decay
3. memory/2025-09-15.md  (score: 0.91 × 0.03 = 0.03)  ← 148 days, nearly gone
```

雖然九月的舊筆記擁有最佳的原始語義匹配，但仍然掉到最底部。

**啟用時機：** 如果您的代理有數個月的每日筆記，並且您發現舊的、過時的資訊超過了最近的上下文。對於以每日筆記為主的工作流程，30 天的半衰期效果良好；如果您經常參考較舊的筆記，可以將其增加（例如，90 天）。

#### Configuration

這兩個功能都在 `memorySearch.query.hybrid` 中進行設定：

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

您可以獨立啟用任一功能：

- **僅 MMR** — 當你有許多相似的筆記但年齡不重要時非常有用。
- **僅時間衰減** — 當近期性重要但你的結果已經多樣化時非常有用。
- **兩者皆可** — 建議用於擁有大量、長期執行的每日筆記歷史的代理。

### 嵌入快取

OpenClaw 可以在 SQLite 中快取 **chunk embeddings**，因此重新索引和頻繁更新（特別是會話記錄）不會重新嵌入未更改的文本。

Config:

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

### Session memory search (experimental)

您可以選擇性地索引 **會話記錄**，並透過 `memory_search` 顯示它們。這項功能需要啟用實驗性標誌。

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

[[BLOCK_1]]

- 會話索引是 **選擇性**（預設為關閉）。
- 會話更新會進行去彈跳處理，並在超過變化閾值後 **異步索引**（最佳努力）。
- `memory_search` 永遠不會在索引上阻塞；結果可能會稍微過時，直到背景同步完成。
- 結果仍然僅包含片段；`memory_get` 仍然限於記憶體檔案。
- 會話索引是針對每個代理獨立的（僅索引該代理的會話日誌）。
- 會話日誌存儲在磁碟上 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)。任何具有檔案系統存取權的過程/使用者都可以讀取它們，因此請將磁碟存取視為信任邊界。為了更嚴格的隔離，請在不同的作業系統使用者或主機下執行代理。

Delta 閾值（顯示預設值）：

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

當 sqlite-vec 擴充可用時，OpenClaw 將嵌入儲存在 SQLite 虛擬表 (`vec0`) 中，並在資料庫中執行向量距離查詢。這樣可以保持搜尋快速，而無需將每個嵌入載入到 JS 中。

Configuration (optional):

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

[[BLOCK_1]]

- `enabled` 預設為 true；當禁用時，搜尋將回退到對儲存的嵌入進行的內部處理餘弦相似度。
- 如果缺少 sqlite-vec 擴充或無法加載，OpenClaw 會記錄錯誤並繼續使用 JS 回退（沒有向量表）。
- `extensionPath` 會覆蓋捆綁的 sqlite-vec 路徑（對於自定義構建或非標準安裝位置非常有用）。

### Local embedding auto-download

- 預設本地嵌入模型: `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB)。
- 當 `memorySearch.provider = "local"` 時，`node-llama-cpp` 解析 `modelPath`；如果缺少 GGUF，則會 **自動下載** 到快取中（或 `local.modelCacheDir` 如果已設置），然後加載它。下載在重試時會繼續。
- 原生構建要求：執行 `pnpm approve-builds`，選擇 `node-llama-cpp`，然後 `pnpm rebuild node-llama-cpp`。
- 備援：如果本地設置失敗且 `memorySearch.fallback = "openai"`，我們會自動切換到遠端嵌入 (`openai/text-embedding-3-small` 除非被覆蓋) 並記錄原因。

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

[[BLOCK_1]]

- `remote.*` 優先於 `models.providers.openai.*`。
- `remote.headers` 與 OpenAI 標頭合併；在關鍵衝突中，遠端的勝出。省略 `remote.headers` 以使用 OpenAI 的預設值。
