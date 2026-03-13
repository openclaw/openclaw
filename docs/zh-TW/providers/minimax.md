---
summary: Use MiniMax M2.5 in OpenClaw
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: MiniMax
---

# MiniMax

MiniMax 是一家專注於打造 **M2/M2.5** 模型系列的 AI 公司。當前以程式碼為主的版本為 **MiniMax M2.5**（2025 年 12 月 23 日發佈），專為真實世界的複雜任務設計。

來源：[MiniMax M2.5 發佈說明](https://www.minimax.io/news/minimax-m25)

## 模型概覽（M2.5）

MiniMax 在 M2.5 中強調以下改進：

- 更強大的 **多語言程式碼編寫**（Rust、Java、Go、C++、Kotlin、Objective-C、TS/JS）。
- 更佳的 **網頁/應用程式開發** 與美學輸出品質（包含原生行動裝置）。
- 改進的 **複合指令** 處理，適用於辦公風格工作流程，基於交錯思考與整合約束執行。
- **更簡潔的回應**，降低 token 使用量並加快迭代速度。
- 更強的 **工具/代理框架** 相容性與上下文管理（支援 Claude Code、Droid/Factory AI、Cline、Kilo Code、Roo Code、BlackBox）。
- 更高品質的 **對話與技術寫作** 輸出。

## MiniMax M2.5 與 MiniMax M2.5 Highspeed 比較

- **速度：** `MiniMax-M2.5-highspeed` 是 MiniMax 文件中官方的高速版本。
- **費用：** MiniMax 價格表中，高速版本輸入費用相同，輸出費用較高。
- **目前模型 ID：** 請使用 `MiniMax-M2.5` 或 `MiniMax-M2.5-highspeed`。

## 選擇設定方案

### MiniMax OAuth（Coding Plan）— 推薦方案

**適合對象：** 透過 OAuth 快速設定 MiniMax Coding Plan，無需 API 金鑰。

啟用內建 OAuth 外掛並完成驗證：

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

系統將提示您選擇端點：

- **Global** - 國際用戶 (`api.minimax.io`)
- **CN** - 中國用戶 (`api.minimaxi.com`)

請參考 [MiniMax OAuth 外掛 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) 了解詳細資訊。

### MiniMax M2.5（API 金鑰）

**適用於：** 使用 Anthropic 相容 API 的 MiniMax 託管服務。

透過 CLI 設定：

- 執行 `openclaw configure`
- 選擇 **Model/auth**
- 選擇 **MiniMax M2.5**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.5" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.5-highspeed",
            name: "MiniMax M2.5 Highspeed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.5 作為備援（範例）

**適用於：** 將您最強大的最新世代模型設為主要，失敗時切換到 MiniMax M2.5。
以下範例以 Opus 作為具體的主要模型；您可替換成您偏好的最新世代主要模型。

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "primary" },
        "minimax/MiniMax-M2.5": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.5"],
      },
    },
  },
}
```

### 選用：透過 LM Studio 本地執行（手動）

**適用於：** 使用 LM Studio 進行本地推論。
我們在強大硬體（例如桌上型電腦/伺服器）搭配 LM Studio 本地伺服器執行 MiniMax M2.5 時，觀察到良好效能。

透過 `openclaw.json` 手動設定：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: { "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 透過 `openclaw configure` 設定

使用互動式設定精靈設定 MiniMax，無需編輯 JSON：

1. 執行 `openclaw configure`。
2. 選擇 **Model/auth**。
3. 選擇 **MiniMax M2.5**。
4. 在提示時選擇您的預設模型。

## 設定選項

- `models.providers.minimax.baseUrl`：優先使用 `https://api.minimax.io/anthropic`（相容 Anthropic）；`https://api.minimax.io/v1` 為 OpenAI 相容的選用專案。
- `models.providers.minimax.api`：優先使用 `anthropic-messages`；`openai-completions` 為 OpenAI 相容的選用專案。
- `models.providers.minimax.apiKey`：MiniMax API 金鑰 (`MINIMAX_API_KEY`)。
- `models.providers.minimax.models`：定義 `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost`。
- `agents.defaults.models`：您想加入允許清單的模型別名。
- `models.mode`：如果想要在內建模型旁加入 MiniMax，請保留 `merge`。

## 注意事項

- 模型參考為 `minimax/<model>`。
- 推薦的模型 ID：`MiniMax-M2.5` 和 `MiniMax-M2.5-highspeed`。
- Coding Plan 使用的 API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（需要 coding plan 金鑰）。
- 若需精確成本追蹤，請在 `models.json` 更新價格數值。
- MiniMax Coding Plan 推薦連結（九折優惠）：[https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 供應商規則請參考 [/concepts/model-providers](/concepts/model-providers)。
- 使用 `openclaw models list` 和 `openclaw models set minimax/MiniMax-M2.5` 來切換。

## 疑難排解

### 「未知模型：minimax/MiniMax-M2.5」

這通常表示 **MiniMax 供應商未設定**（找不到供應商條目，也沒有 MiniMax 認證設定檔或環境金鑰）。此偵測問題的修正已包含在
**2026.1.12** 版本（撰寫時尚未釋出）。修正方式如下：

- 升級至 **2026.1.12**（或從原始碼 `main` 執行），然後重新啟動 gateway。
- 執行 `openclaw configure` 並選擇 **MiniMax M2.5**，或
- 手動加入 `models.providers.minimax` 區塊，或
- 設定 `MINIMAX_API_KEY`（或 MiniMax 認證設定檔），以便注入供應商。

請確認模型 ID 為 **大小寫敏感**：

- `minimax/MiniMax-M2.5`
- `minimax/MiniMax-M2.5-highspeed`

然後使用以下指令重新檢查：

```bash
openclaw models list
```
