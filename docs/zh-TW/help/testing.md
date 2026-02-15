---
summary: "測試套件：單元/e2e/即時套件、Docker 執行器，以及每個測試所涵蓋的範圍"
read_when:
  - 在本地或 CI 中執行測試
  - 為模型/供應商錯誤新增回歸測試
  - 偵錯 Gateway + 代理程式行為
title: "測試"
---

# 測試

OpenClaw 具有三個 Vitest 套件（單元/整合、e2e、即時）和一小組 Docker 執行器。

這份文件是「我們如何測試」的指南：

- 每個套件涵蓋的範圍（以及特意不涵蓋的範圍）
- 針對常見工作流程（本地、預推送、偵錯）要執行的命令
- 即時測試如何發現憑證並選擇模型/供應商
- 如何為實際的模型/供應商問題新增回歸測試

## 快速入門

大多數時候：

- 完整檢查 (推送前預期)：`pnpm build && pnpm check && pnpm test`

當您碰觸測試或需要額外信心時：

- 覆蓋率檢查：`pnpm test:coverage`
- E2E 套件：`pnpm test:e2e`

偵錯實際供應商/模型時（需要實際憑證）：

- 即時套件（模型 + Gateway 工具/影像探測）：`pnpm test:live`

提示：當您只需要一個失敗案例時，最好透過下方描述的允許清單環境變數來縮小即時測試範圍。

## 測試套件 (在哪裡執行)

將套件視為「增加真實性」（以及增加不穩定性/成本）：

### 單元 / 整合 (預設)

- 命令：`pnpm test`
- 設定：`vitest.config.ts`
- 檔案：`src/**/*.test.ts`
- 範圍：
  - 純單元測試
  - 流程中整合測試 (Gateway 認證、路由、工具、解析、設定)
  - 已知錯誤的確定性回歸測試
- 期望：
  - 在 CI 中執行
  - 不需要實際金鑰
  - 應快速穩定
- 集區說明：
  - OpenClaw 在 Node 22/23 上使用 Vitest `vmForks` 來加速單元分片。
  - 在 Node 24+ 上，OpenClaw 自動回退到常規 `forks` 以避免 Node VM 連結錯誤 (`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`)。
  - 使用 `OPENCLAW_TEST_VM_FORKS=0` (強制 `forks`) 或 `OPENCLAW_TEST_VM_FORKS=1` (強制 `vmForks`) 手動覆寫。

### E2E (Gateway 健全性測試)

- 命令：`pnpm test:e2e`
- 設定：`vitest.e2e.config.ts`
- 檔案：`src/**/*.e2e.test.ts`
- 執行時預設值：
  - 使用 Vitest `vmForks` 來加速檔案啟動。
  - 使用自適應工作者 (CI：2-4，本地：4-8)。
  - 預設以靜默模式執行以減少控制台 I/O 開銷。
- 有用的覆寫：
  - `OPENCLAW_E2E_WORKERS=<n>` 以強制工作者數量 (上限為 16)。
  - `OPENCLAW_E2E_VERBOSE=1` 以重新啟用詳細的控制台輸出。
- 範圍：
  - 多實例 Gateway 端對端行為
  - WebSocket/HTTP 介面、節點配對和更繁重的網路
- 期望：
  - 在 CI 中執行 (當在管線中啟用時)
  - 不需要實際金鑰
  - 比單元測試有更多的活動部件 (可能會較慢)

### 即時 (實際供應商 + 實際模型)

- 命令：`pnpm test:live`
- 設定：`vitest.live.config.ts`
- 檔案：`src/**/*.live.test.ts`
- 預設：由 `pnpm test:live` **啟用** (設定 `OPENCLAW_LIVE_TEST=1`)
- 範圍：
  - 「這個供應商/模型今天使用實際憑證是否真的有效？」
  - 捕捉供應商格式變更、工具呼叫怪癖、認證問題和速率限制行為
- 期望：
  - 設計上不穩定於 CI (實際網路、實際供應商政策、配額、中斷)
  - 花費金錢/使用速率限制
  - 最好執行縮小後的子集，而不是「所有項目」
  - 即時執行將來源 `~/.profile` 以取得遺失的 API 金鑰
  - Anthropic 金鑰輪換：設定 `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (或 `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) 或多個 `ANTHROPIC_API_KEY*` 變數；測試將在速率限制時重試

## 我應該執行哪個套件？

使用此決策表：

- 編輯邏輯/測試：執行 `pnpm test` (如果您更改了很多，則執行 `pnpm test:coverage`)
- 觸碰 Gateway 網路 / WS 協定 / 配對：新增 `pnpm test:e2e`
- 偵錯「我的機器人當機」/ 供應商特定故障 / 工具呼叫：執行縮小後的 `pnpm test:live`

## 即時：模型健全性測試 (設定檔金鑰)

即時測試分為兩層，因此我們可以隔離故障：

- 「直接模型」告訴我們供應商/模型是否可以使用給定的金鑰進行應答。
- 「Gateway 健全性測試」告訴我們完整的 Gateway+代理程式管線是否適用於該模型 (會話、歷史紀錄、工具、沙盒策略等)。

### 第 1 層：直接模型完成 (無 Gateway)

- 測試：`src/agents/models.profiles.live.test.ts`
- 目標：
  - 列舉已發現的模型
  - 使用 `getApiKeyForModel` 選擇您擁有憑證的模型
  - 每個模型執行一個小的完成 (並在需要時進行有針對性的回歸測試)
- 如何啟用：
  - `pnpm test:live` (或直接調用 Vitest 時使用 `OPENCLAW_LIVE_TEST=1`)
- 設定 `OPENCLAW_LIVE_MODELS=modern` (或 `all`，`modern` 的別名) 以實際執行此套件；否則它會跳過以使 `pnpm test:live` 專注於 Gateway 健全性測試
- 如何選擇模型：
  - `OPENCLAW_LIVE_MODELS=modern` 以執行現代允許清單 (Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` 是現代允許清單的別名
  - 或 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (逗號允許清單)
- 如何選擇供應商：
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (逗號允許清單)
- 金鑰來源：
  - 預設：設定檔儲存和環境變數備援
  - 設定 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 以強制只使用**設定檔儲存**
- 為何存在：
  - 將「供應商 API 損壞/金鑰無效」與「Gateway 代理程式管線損壞」分開
  - 包含小型、獨立的回歸測試 (例如：OpenAI Responses/Codex Responses 推理重播 + 工具呼叫流程)

### 第 2 層：Gateway + 開發代理程式健全性測試 (「@openclaw」實際執行的內容)

- 測試：`src/gateway/gateway-models.profiles.live.test.ts`
- 目標：
  - 啟動一個流程中 Gateway
  - 建立/修補 `agent:dev:*` 會話 (每次執行覆寫模型)
  - 迭代帶有金鑰的模型並斷言：
    - 「有意義的」回應 (無工具)
    - 實際的工具調用有效 (讀取探測)
    - 可選的額外工具探測 (執行+讀取探測)
    - OpenAI 回歸路徑 (僅工具呼叫 → 後續) 繼續有效
- 探測詳細資訊 (以便您快速解釋故障)：
  - `read` 探測：測試在工作區中寫入一個 nonce 檔案，並要求代理程式 `read` 它並將 nonce 回傳。
  - `exec+read` 探測：測試要求代理程式 `exec`-寫入一個 nonce 到臨時檔案，然後 `read` 它。
  - 影像探測：測試附加一個生成的 PNG (貓 + 隨機代碼)，並期望模型返回 `cat <CODE>`。
  - 實作參考：`src/gateway/gateway-models.profiles.live.test.ts` 和 `src/gateway/live-image-probe.ts`。
- 如何啟用：
  - `pnpm test:live` (或直接調用 Vitest 時使用 `OPENCLAW_LIVE_TEST=1`)
- 如何選擇模型：
  - 預設：現代允許清單 (Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` 是現代允許清單的別名
  - 或設定 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (或逗號清單) 以縮小範圍
- 如何選擇供應商 (避免「OpenRouter 所有項目」)：
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (逗號允許清單)
- 此即時測試中的工具 + 影像探測始終開啟：
  - `read` 探測 + `exec+read` 探測 (工具壓力測試)
  - 當模型宣傳影像輸入支援時，影像探測會執行
  - 流程 (高階)：
    - 測試生成一個帶有「CAT」+ 隨機代碼的微小 PNG (`src/gateway/live-image-probe.ts`)
    - 透過 `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` 發送
    - Gateway 將附件解析為 `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - 嵌入式代理程式將多模式使用者訊息轉發給模型
    - 斷言：回覆包含 `cat` + 代碼 (OCR 容忍度：允許輕微錯誤)

提示：要查看您機器上可以測試的內容 (以及確切的 `provider/model` ID)，請執行：

```bash
openclaw models list
openclaw models list --json
```

## 即時：Anthropic setup-token 健全性測試

- 測試：`src/agents/anthropic.setup-token.live.test.ts`
- 目標：驗證 Claude Code CLI setup-token (或貼上的 setup-token 設定檔) 可以完成 Anthropic 提示。
- 啟用：
  - `pnpm test:live` (或直接調用 Vitest 時使用 `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- 權杖來源 (選擇一個)：
  - 設定檔：`OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 原始權杖：`OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 模型覆寫 (可選)：
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

設定範例：

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## 即時：CLI 後端健全性測試 (Claude Code CLI 或其他本地 CLI)

- 測試：`src/gateway/gateway-cli-backend.live.test.ts`
- 目標：使用本地 CLI 後端驗證 Gateway + 代理程式管線，而不觸碰您的預設設定。
- 啟用：
  - `pnpm test:live` (或直接調用 Vitest 時使用 `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 預設值：
  - 模型：`claude-cli/claude-sonnet-4-5`
  - 命令：`claude`
  - 引數：`["-p","--output-format","json","--dangerously-skip-permissions"]`
- 覆寫 (可選)：
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` 以發送實際的影像附件 (路徑注入到提示中)。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` 以將影像檔案路徑作為 CLI 引數傳遞，而不是提示注入。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (或 `"list"`) 以控制當設定 `IMAGE_ARG` 時影像引數的傳遞方式。
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` 以發送第二輪並驗證恢復流程。
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` 以保持 Claude Code CLI MCP 設定啟用 (預設使用臨時空檔案禁用 MCP 設定)。

範例：

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 建議的即時測試方法

縮小、明確的允許清單是最快、最不容易不穩定的：

- 單一模型，直接 (無 Gateway)：
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 單一模型，Gateway 健全性測試：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 跨多個供應商的工具呼叫：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 焦點 (Gemini API 金鑰 + Antigravity)：
  - Gemini (API 金鑰)：`OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth)：`OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

備註：

- `google/...` 使用 Gemini API (API 金鑰)。
- `google-antigravity/...` 使用 Antigravity OAuth 橋接 (Cloud Code Assist 樣式的代理程式端點)。
- `google-gemini-cli/...` 使用您機器上的本地 Gemini CLI (獨立認證 + 工具怪癖)。
- Gemini API 與 Gemini CLI：
  - API：OpenClaw 透過 HTTP 呼叫 Google 託管的 Gemini API (API 金鑰 / 設定檔認證)；這是大多數使用者所指的「Gemini」。
  - CLI：OpenClaw 呼叫本地 `gemini` 二進制檔案；它有自己的認證，並且行為可能不同 (串流/工具支援/版本偏差)。

## 即時：模型矩陣 (我們涵蓋的範圍)

沒有固定的「CI 模型清單」(即時是選擇性加入)，但這些是建議開發機定期使用金鑰涵蓋的**推薦**模型。

### 現代健全性測試集 (工具呼叫 + 影像)

這是我們期望持續運作的「常見模型」執行：

- OpenAI (非 Codex)：`openai/gpt-5.2` (可選：`openai/gpt-5.1`)
- OpenAI Codex：`openai-codex/gpt-5.3-codex` (可選：`openai-codex/gpt-5.3-codex-codex`)
- Anthropic：`anthropic/claude-opus-4-6` (或 `anthropic/claude-sonnet-4-5`)
- Google (Gemini API)：`google/gemini-3-pro-preview` 和 `google/gemini-3-flash-preview` (避免舊的 Gemini 2.x 模型)
- Google (Antigravity)：`google-antigravity/claude-opus-4-6-thinking` 和 `google-antigravity/gemini-3-flash`
- Z.AI (GLM)：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

使用工具 + 影像執行 Gateway 健全性測試：
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 基準：工具呼叫 (讀取 + 可選執行)

每個供應商系列至少選擇一個：

- OpenAI：`openai/gpt-5.2` (或 `openai/gpt-5-mini`)
- Anthropic：`anthropic/claude-opus-4-6` (或 `anthropic/claude-sonnet-4-5`)
- Google：`google/gemini-3-flash-preview` (或 `google/gemini-3-pro-preview`)
- Z.AI (GLM)：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

可選的額外覆蓋率 (最好有)：

- xAI：`xai/grok-4` (或最新可用)
- Mistral：`mistral/`… (選擇一個您已啟用的「工具」功能模型)
- Cerebras：`cerebras/`… (如果您有權限)
- LM Studio：`lmstudio/`… (本地；工具呼叫取決於 API 模式)

### 視覺：影像發送 (附件 → 多模式訊息)

在 `OPENCLAW_LIVE_GATEWAY_MODELS` 中包含至少一個具備影像功能的模型 (Claude/Gemini/OpenAI 具備視覺功能的變體等) 以執行影像探測。

### 聚合器 / 替代 Gateway

如果您已啟用金鑰，我們也支援透過以下方式進行測試：

- OpenRouter：`openrouter/...` (數百個模型；使用 `openclaw models scan` 尋找具備工具+影像功能的候選者)
- OpenCode Zen：`opencode/...` (透過 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` 認證)

您可以包含在即時矩陣中的更多供應商 (如果您有憑證/設定)：

- 內建：`openai`、`openai-codex`、`anthropic`、`google`、`google-vertex`、`google-antigravity`、`google-gemini-cli`、`zai`、`openrouter`、`opencode`、`xai`、`groq`、`cerebras`、`mistral`、`github-copilot`
- 透過 `models.providers` (自訂端點)：`minimax` (雲端/API)，以及任何與 OpenAI/Anthropic 相容的代理 (LM Studio、vLLM、LiteLLM 等)

提示：不要試圖在文件中硬編碼「所有模型」。權威清單是您機器上 `discoverModels(...)` 返回的任何內容 + 可用的任何金鑰。

## 憑證 (切勿提交)

即時測試發現憑證的方式與 CLI 相同。實際影響：

- 如果 CLI 有效，即時測試應該會找到相同的金鑰。
- 如果即時測試顯示「沒有憑證」，請以偵錯 `openclaw models list` / 模型選擇的相同方式進行偵錯。

- 設定檔儲存：`~/.openclaw/credentials/` (首選；測試中「設定檔金鑰」的含義)
- 設定：`~/.openclaw/openclaw.json` (或 `OPENCLAW_CONFIG_PATH`)

如果您想依賴環境變數金鑰 (例如在您的 `~/.profile` 中匯出)，請在 `source ~/.profile` 後執行本地測試，或使用下面的 Docker 執行器 (它們可以將 `~/.profile` 掛載到容器中)。

## Deepgram 即時 (音訊轉錄)

- 測試：`src/media-understanding/providers/deepgram/audio.live.test.ts`
- 啟用：`DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker 執行器 (可選的「在 Linux 中運作」檢查)

這些在 repo Docker 映像檔中執行 `pnpm test:live`，掛載您的本地設定目錄和工作區 (如果掛載了 `~/.profile`，也會來源)：

- 直接模型：`pnpm test:docker:live-models` (腳本：`scripts/test-live-models-docker.sh`)
- Gateway + 開發代理程式：`pnpm test:docker:live-gateway` (腳本：`scripts/test-live-gateway-models-docker.sh`)
- 入門精靈 (TTY，完整腳手架)：`pnpm test:docker:onboard` (腳本：`scripts/e2e/onboard-docker.sh`)
- Gateway 網路 (兩個容器，WS 認證 + 健全性)：`pnpm test:docker:gateway-network` (腳本：`scripts/e2e/gateway-network-docker.sh`)
- 外掛程式 (自訂擴充功能載入 + 註冊表健全性測試)：`pnpm test:docker:plugins` (腳本：`scripts/e2e/plugins-docker.sh`)

有用的環境變數：

- `OPENCLAW_CONFIG_DIR=...` (預設：`~/.openclaw`) 掛載到 `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (預設：`~/.openclaw/workspace`) 掛載到 `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (預設：`~/.profile`) 掛載到 `/home/node/.profile` 並在執行測試前來源
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` 以縮小執行範圍
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 以確保憑證來自設定檔儲存 (而非環境變數)

## 文件健全性檢查

文件編輯後執行文件檢查：`pnpm docs:list`。

## 離線回歸測試 (CI 安全)

這些是「實際管線」的回歸測試，沒有實際供應商：

- Gateway 工具呼叫 (模擬 OpenAI，實際 Gateway + 代理程式循環)：`src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway 精靈 (WS `wizard.start`/`wizard.next`，寫入設定 + 強制認證)：`src/gateway/gateway.wizard.e2e.test.ts`

## 代理程式可靠性評估 (技能)

我們已經有一些 CI 安全測試，其行為類似於「代理程式可靠性評估」：

- 透過實際 Gateway + 代理程式循環進行模擬工具呼叫 (`src/gateway/gateway.tool-calling.mock-openai.test.ts`)。
- 端對端精靈流程，驗證會話連線和設定效果 (`src/gateway/gateway.wizard.e2e.test.ts`)。

技能仍缺少的部分 (請參閱 [Skills](/tools/skills))：

- **決策：** 當提示中列出技能時，代理程式是否選擇正確的技能 (或避免不相關的技能)？
- **合規性：** 代理程式是否在使用前閱讀 `SKILL.md` 並遵循所需的步驟/引數？
- **工作流程合約：** 多輪情境，斷言工具順序、會話歷史記錄結轉和沙盒邊界。

未來的評估應首先保持確定性：

- 使用模擬供應商的場景執行器，以斷言工具呼叫 + 順序、技能檔案讀取和會話連線。
- 一小組以技能為中心的場景 (使用與避免、門控、提示注入)。
- 可選的即時評估 (選擇性加入、環境受限) 僅在 CI 安全套件就位後。

## 新增回歸測試 (指南)

當您修復在即時中發現的供應商/模型問題時：

- 如果可能，新增 CI 安全的回歸測試 (模擬/存根供應商，或捕捉確切的請求形狀轉換)
- 如果本質上是即時專用 (速率限制、認證政策)，請透過環境變數保持即時測試範圍縮小且選擇性加入
- 最好針對捕捉錯誤的最小層級：
  - 供應商請求轉換/重播錯誤 → 直接模型測試
  - Gateway 會話/歷史記錄/工具管線錯誤 → Gateway 即時健全性測試或 CI 安全 Gateway 模擬測試
