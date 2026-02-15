---
summary: "測試套件：單元/e2e/live 測試組、Docker 執行器，以及各項測試涵蓋範圍"
read_when:
  - 在本地或 CI 執行測試時
  - 針對模型/供應商錯誤新增迴歸測試時
  - 偵錯 Gateway + 智慧代理行為時
title: "測試"
---

# 測試

OpenClaw 擁有三個 Vitest 測試組（單元/整合、e2e、live）以及一組小型 Docker 執行器。

本文件為「如何測試」指南：

- 各個測試組涵蓋的範圍（以及刻意不涵蓋的部分）
- 常用工作流程（本地、推送前、偵錯）應執行的指令
- Live 測試如何探索憑證並選擇模型/供應商
- 如何針對實際的模型/供應商問題新增迴歸測試

## 快速開始

日常作業：

- 完整門檻（建議推送前執行）：`pnpm build && pnpm check && pnpm test`

當你修改測試或需要額外信心時：

- 涵蓋率門檻：`pnpm test:coverage`
- E2E 測試組：`pnpm test:e2e`

偵錯實際供應商/模型時（需要真實憑證）：

- Live 測試組（模型 + Gateway 工具/影像探針）：`pnpm test:live`

提示：當你只需要一個失敗案例時，建議透過下方說明的允許清單環境變數來縮小 live 測試範圍。

## 測試組（各項測試執行位置）

將這些測試組視為「真實度遞增」（以及不穩定性/成本遞增）：

### 單元 / 整合（預設）

- 指令：`pnpm test`
- 設定：`vitest.config.ts`
- 檔案：`src/**/*.test.ts`
- 範圍：
  - 純單元測試
  - 進程內整合測試（Gateway 驗證、路由、工具、解析、設定）
  - 針對已知錯誤的確定性迴歸測試
- 預期效果：
  - 在 CI 中執行
  - 不需要真實金鑰
  - 應保持快速且穩定
- 執行池說明：
  - OpenClaw 在 Node 22/23 上使用 Vitest `vmForks` 以加快單元分片速度。
  - 在 Node 24+，OpenClaw 會自動回退到一般的 `forks`，以避免 Node VM 連結錯誤（`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`）。
  - 可透過 `OPENCLAW_TEST_VM_FORKS=0`（強制 `forks`）或 `OPENCLAW_TEST_VM_FORKS=1`（強制 `vmForks`）手動覆寫。

### E2E (Gateway 冒煙測試)

- 指令：`pnpm test:e2e`
- 設定：`vitest.e2e.config.ts`
- 檔案：`src/**/*.e2e.test.ts`
- 執行階段預設值：
  - 使用 Vitest `vmForks` 以加快檔案啟動。
  - 使用自適應 Worker（CI：2-4，本地：4-8）。
  - 預設以靜默模式執行，以減少主控台 I/O 開銷。
- 有用的覆寫設定：
  - `OPENCLAW_E2E_WORKERS=<n>` 強制 Worker 數量（上限為 16）。
  - `OPENCLAW_E2E_VERBOSE=1` 重新啟用詳細的主控台輸出。
- 範圍：
  - 多實例 Gateway 端到端行為
  - WebSocket/HTTP 介面、節點配對以及較重的網路負載
- 預期效果：
  - 在 CI 中執行（若在流水線中已啟用）
  - 不需要真實金鑰
  - 比單元測試有更多變動組件（速度可能較慢）

### Live (真實供應商 + 真實模型)

- 指令：`pnpm test:live`
- 設定：`vitest.live.config.ts`
- 檔案：`src/**/*.live.test.ts`
- 預設值：由 `pnpm test:live` **啟用**（會設定 `OPENCLAW_LIVE_TEST=1`）
- 範圍：
  - 「這個供應商/模型今天搭配真實憑證是否真的能運作？」
  - 捕捉供應商格式變更、工具呼叫怪癖、驗證問題以及速率限制行為
- 預期效果：
  - 設計上並非 CI 穩定（真實網路、真實供應商政策、配額、斷線）
  - 會產生費用 / 使用速率限制
  - 建議執行縮小的子集，而非「全部」
  - Live 執行會讀取 `~/.profile` 以取得缺失的 API 金鑰
  - Anthropic 金鑰輪替：設定 `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."`（或 `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`）或多個 `ANTHROPIC_API_KEY*` 變數；測試會在遇到速率限制時重試

## 我該執行哪種測試組？

請參考此決策表：

- 修改邏輯/測試：執行 `pnpm test`（若改動較多則執行 `pnpm test:coverage`）
- 修改 Gateway 網路 / WS 協定 / 配對：增加 `pnpm test:e2e`
- 偵錯「我的機器人掛了」/ 供應商特定失敗 / 工具呼叫：執行縮小範圍的 `pnpm test:live`

## Live：模型冒煙測試（設定檔金鑰）

Live 測試分為兩層，以便隔離失敗原因：

- 「直接模型」讓我們知道供應商/模型是否能使用給定的金鑰回應。
- 「Gateway 冒煙測試」讓我們知道該模型的完整 Gateway+智慧代理流水線（工作階段、歷史紀錄、工具、沙箱政策等）是否運作正常。

### 第一層：直接模型補全（不經過 Gateway）

- 測試：`src/agents/models.profiles.live.test.ts`
- 目標：
  - 列舉探索到的模型
  - 使用 `getApiKeyForModel` 選擇你有憑證的模型
  - 針對每個模型執行小型補全（並在需要時執行特定迴歸測試）
- 如何啟用：
  - `pnpm test:live`（或直接呼叫 Vitest 時設定 `OPENCLAW_LIVE_TEST=1`）
- 設定 `OPENCLAW_LIVE_MODELS=modern`（或 `all`，即現代模型別名）以實際執行此測試組；否則它會跳過，讓 `pnpm test:live` 專注於 Gateway 冒煙測試
- 如何選擇模型：
  - `OPENCLAW_LIVE_MODELS=modern` 執行現代允許清單（Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4）
  - `OPENCLAW_LIVE_MODELS=all` 是現代允許清單的別名
  - 或 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."`（逗號分隔的允許清單）
- 如何選擇供應商：
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"`（逗號分隔的允許清單）
- 金鑰來源：
  - 預設：設定檔儲存區（profile store）與環境變數備援
  - 設定 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 強制僅使用 **設定檔儲存區**
- 為什麼需要這個：
  - 區分「供應商 API 壞了 / 金鑰無效」與「Gateway 智慧代理流水線壞了」
  - 包含小型、隔離的迴歸測試（例如：OpenAI Responses/Codex Responses 推理回放 + 工具呼叫流程）

### 第二層：Gateway + 開發智慧代理冒煙測試（實際上 “ @openclaw” 在做什麼）

- 測試：`src/gateway/gateway-models.profiles.live.test.ts`
- 目標：
  - 啟動一個進程內 Gateway
  - 建立/修補一個 `agent:dev:*` 工作階段（每次執行覆蓋模型）
  - 迭代含有金鑰的模型並斷言：
    - 有意義的回應（無工具）
    - 實際工具調用可運作（讀取探針）
    - 選用的額外工具探針（執行+讀取探針）
    - OpenAI 迴歸路徑（僅工具呼叫 → 後續跟進）持續運作
- 探針詳情（以便快速說明失敗原因）：
  - `read` 探針：測試在工作區寫入一個 nonce 檔案，並要求智慧代理讀取（`read`）它並回傳該 nonce。
  - `exec+read` 探針：測試要求智慧代理透過 `exec` 將 nonce 寫入暫存檔，然後再將其讀回（`read`）。
  - 影像（image）探針：測試附加一個產生的 PNG（貓 + 隨機代碼），並預期模型回傳 `cat <CODE>`。
  - 實作參考：`src/gateway/gateway-models.profiles.live.test.ts` 與 `src/gateway/live-image-probe.ts`。
- 如何啟用：
  - `pnpm test:live`（或直接呼叫 Vitest 時設定 `OPENCLAW_LIVE_TEST=1`）
- 如何選擇模型：
  - 預設：現代允許清單（Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4）
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` 是現代允許清單的別名
  - 或設定 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"`（或逗號清單）以縮小範圍
- 如何選擇供應商（避免「OpenRouter 掃描全部」）：
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"`（逗號分隔的允許清單）
- 在此 live 測試中，工具與影像探針一律開啟：
  - `read` 探針 + `exec+read` 探針（工具壓力測試）
  - 當模型宣告支援影像輸入時，會執行影像探針
  - 流程（高階）：
    - 測試產生一個帶有「CAT」與隨機代碼的小型 PNG (`src/gateway/live-image-probe.ts`)
    - 透過智慧代理發送 `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway 將附件解析為 `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - 嵌入式智慧代理將多模態使用者訊息轉發給模型
    - 斷言：回覆包含 `cat` + 該代碼（OCR 容錯：允許輕微錯誤）

提示：要查看你機器上可以測試什麼（以及確切的 `provider/model` ID），請執行：

```bash
openclaw models list
openclaw models list --json
```

## Live：Anthropic setup-token 冒煙測試

- 測試：`src/agents/anthropic.setup-token.live.test.ts`
- 目標：驗證 Claude Code CLI setup-token（或貼上的 setup-token 設定檔）可以完成 Anthropic 提示詞。
- 啟用：
  - `pnpm test:live`（或直接呼叫 Vitest 時設定 `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Token 來源（擇一）：
  - 設定檔：`OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 原始 Token：`OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 模型覆蓋（選用）：
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

設定範例：

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live：CLI 後端冒煙測試（Claude Code CLI 或其他本地 CLI）

- 測試：`src/gateway/gateway-cli-backend.live.test.ts`
- 目標：使用本地 CLI 後端驗證 Gateway + 智慧代理流水線，且不更動你的預設設定。
- 啟用：
  - `pnpm test:live`（或直接呼叫 Vitest 時設定 `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 預設值：
  - 模型：`claude-cli/claude-sonnet-4-5`
  - 指令：`claude`
  - 參數：`["-p","--output-format","json","--dangerously-skip-permissions"]`
- 覆蓋設定（選用）：
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` 發送真實影像附件（路徑會注入提示詞）。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` 將影像檔案路徑作為 CLI 參數傳遞，而非提示詞注入。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"`（或 `"list"`）控制設定 `IMAGE_ARG` 時影像參數的傳遞方式。
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` 發送第二次對話並驗證恢復流程。
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` 保持 Claude Code CLI MCP 設定開啟（預設會使用暫存空檔案停用 MCP 設定）。

範例：

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 推薦的 live 配方

範圍小且明確的允許清單最快且最穩定：

- 單一模型，直接（不經過 Gateway）：
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 單一模型，Gateway 冒煙測試：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 橫跨多個供應商的工具呼叫：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 專注測試（Gemini API 金鑰 + Antigravity）：
  - Gemini (API 金鑰)：`OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth)：`OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

備註：

- `google/...` 使用 Gemini API (API 金鑰)。
- `google-antigravity/...` 使用 Antigravity OAuth 橋接器（Cloud Code Assist 風格的智慧代理端點）。
- `google-gemini-cli/...` 使用你機器上的本地 Gemini CLI（獨立的驗證與工具怪癖）。
- Gemini API vs Gemini CLI：
  - API：OpenClaw 透過 HTTP 呼叫 Google 代管的 Gemini API（API 金鑰 / 設定檔驗證）；這就是大多數使用者所指的「Gemini」。
  - CLI：OpenClaw 呼叫本地的 `gemini` 執行檔；它有自己的驗證方式，且行為可能不同（串流/工具支援/版本差異）。

## Live：模型矩陣（我們涵蓋的範圍）

雖然沒有固定的「CI 模型清單」（live 是自由加入的），但這些是建議在有金鑰的開發機器上定期涵蓋的模型。

### 現代冒煙測試組（工具呼叫 + 影像）

這是我們預期應持續運作的「常用模型」執行組：

- OpenAI (非 Codex)：`openai/gpt-5.2` (選用：`openai/gpt-5.1`)
- OpenAI Codex：`openai-codex/gpt-5.3-codex` (選用：`openai-codex/gpt-5.3-codex-codex`)
- Anthropic：`anthropic/claude-opus-4-6` (或 `anthropic/claude-sonnet-4-5`)
- Google (Gemini API)：`google/gemini-3-pro-preview` 與 `google/gemini-3-flash-preview`（避免使用舊版 Gemini 2.x 模型）
- Google (Antigravity)：`google-antigravity/claude-opus-4-6-thinking` 與 `google-antigravity/gemini-3-flash`
- Z.AI (GLM)：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

搭配工具與影像執行 Gateway 冒煙測試：
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 基準線：工具呼叫（讀取 + 選用執行）

每個供應商家族至少選擇一個：

- OpenAI：`openai/gpt-5.2` (或 `openai/gpt-5-mini`)
- Anthropic：`anthropic/claude-opus-4-6` (或 `anthropic/claude-sonnet-4-5`)
- Google：`google/gemini-3-flash-preview` (或 `google/gemini-3-pro-preview`)
- Z.AI (GLM)：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

選用的額外涵蓋範圍（加分項）：

- xAI：`xai/grok-4`（或最新可用版本）
- Mistral：`mistral/`…（選擇一個你已啟用且具備「工具」處理能力的模型）
- Cerebras：`cerebras/`…（如果你有存取權限）
- LM Studio：`lmstudio/`…（本地；工具呼叫取決於 API 模式）

### 視覺：影像發送（附件 → 多模態訊息）

在 `OPENCLAW_LIVE_GATEWAY_MODELS` 中包含至少一個具備影像處理能力的模型（Claude/Gemini/OpenAI 具備視覺能力的變體等），以執行影像探針。

### 聚合器 / 其他 Gateway

如果你已啟用金鑰，我們也支援透過以下方式測試：

- OpenRouter：`openrouter/...`（數百種模型；使用 `openclaw models scan` 尋找支援工具與影像的候選模型）
- OpenCode Zen：`opencode/...`（透過 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` 驗證）

更多你可以包含在 live 矩陣中的供應商（如果你有憑證/設定）：

- 內建：`openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- 透過 `models.providers`（自定義端點）：`minimax`（雲端/API），以及任何相容於 OpenAI/Anthropic 的代理伺服器（LM Studio, vLLM, LiteLLM 等）

提示：不要試圖在文件中硬編碼「所有模型」。權威清單取決於你機器上 `discoverModels(...)` 回傳的內容以及可用的金鑰。

## 憑證（切勿提交）

Live 測試探索憑證的方式與 CLI 相同。實際影響：

- 如果 CLI 可運作，live 測試應能找到相同的金鑰。
- 如果 live 測試顯示「無憑證」，請按照偵錯 `openclaw models list` / 模型選擇的方式進行偵錯。

- 設定檔儲存區：`~/.openclaw/credentials/`（偏好方式；測試中所謂的「設定檔金鑰」）
- 設定：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）

如果你想依賴環境變數金鑰（例如在 `~/.profile` 中匯出），請在 `source ~/.profile` 後執行本地測試，或使用下方的 Docker 執行器（它們可以將 `~/.profile` 掛載到容器中）。

## Deepgram live (音訊轉錄)

- 測試：`src/media-understanding/providers/deepgram/audio.live.test.ts`
- 啟用：`DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker 執行器（選用的「在 Linux 運作」檢查）

這些會在儲存庫 Docker 映像檔中執行 `pnpm test:live`，並掛載你的本地設定目錄與工作區（若有掛載則會讀取 `~/.profile`）：

- 直接模型：`pnpm test:docker:live-models`（指令碼：`scripts/test-live-models-docker.sh`）
- Gateway + 開發智慧代理：`pnpm test:docker:live-gateway`（指令碼：`scripts/test-live-gateway-models-docker.sh`）
- 新手導覽精靈（TTY，完整腳手架）：`pnpm test:docker:onboard`（指令碼：`scripts/e2e/onboard-docker.sh`）
- Gateway 網路（兩個容器，WS 驗證 + 健康檢查）：`pnpm test:docker:gateway-network`（指令碼：`scripts/e2e/gateway-network-docker.sh`）
- 外掛程式（自定義擴充載入 + 註冊表冒煙測試）：`pnpm test:docker:plugins`（指令碼：`scripts/e2e/plugins-docker.sh`）

有用的環境變數：

- `OPENCLAW_CONFIG_DIR=...`（預設：`~/.openclaw`）掛載至 `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...`（預設：`~/.openclaw/workspace`）掛載至 `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...`（預設：`~/.profile`）掛載至 `/home/node/.profile` 並在執行測試前讀取
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` 以縮小執行範圍
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 確保憑證來自設定檔儲存區（而非環境變數）

## 文件完整性檢查

在編輯文件後執行文件檢查：`pnpm docs:list`。

## 離線迴歸測試 (CI 安全)

這些是不需真實供應商的「真實流水線」迴歸測試：

- Gateway 工具呼叫（模擬 OpenAI，真實 Gateway + 智慧代理迴圈）：`src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway 精靈（WS `wizard.start`/`wizard.next`，寫入設定 + 強制驗證）：`src/gateway/gateway.wizard.e2e.test.ts`

## 智慧代理可靠性評估 (Skills)

我們已經有一些 CI 安全的測試，其行為類似「智慧代理可靠性評估」：

- 透過真實 Gateway + 智慧代理迴圈進行模擬工具呼叫 (`src/gateway/gateway.tool-calling.mock-openai.test.ts`)。
- 驗證工作階段串接與設定效果的端到端精靈流程 (`src/gateway/gateway.wizard.e2e.test.ts`)。

Skills 仍缺失的部分（參見 [Skills](/tools/skills)）：

- **決策：** 當提示詞中列出 Skills 時，智慧代理是否選擇了正確的 Skill（或避開無關的 Skill）？
- **合規性：** 智慧代理在執行前是否讀取了 `SKILL.md` 並遵循要求的步驟/參數？
- **工作流程協定：** 斷言工具順序、工作階段歷史承接以及沙箱邊界的多次對話情境。

未來的評估應優先保持確定性：

- 使用模擬供應商斷言工具呼叫與順序、Skill 檔案讀取以及工作階段串接的情境執行器。
- 一組專注於 Skill 的情境（使用與避免、門檻控管、提示詞注入）。
- 僅在 CI 安全測試組就緒後，才提供選用的 live 評估（自由加入、環境變數控管）。

## 新增迴歸測試（指南）

當你修復在 live 中發現的供應商/模型問題時：

- 如果可能，請新增 CI 安全的迴歸測試（模擬/存根供應商，或擷取精確的請求形狀轉換）
- 如果本質上僅限 live（速率限制、驗證政策），請保持 live 測試範圍狹窄，並透過環境變數加入
- 優先針對能捕捉到錯誤的最小層級：
  - 供應商請求轉換/回放錯誤 → 直接模型測試
  - Gateway 工作階段/歷史/工具流水線錯誤 → Gateway live 冒煙測試或 CI 安全的 Gateway 模擬測試
