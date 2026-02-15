---
summary: "在 OpenClaw 中使用 MiniMax M2.1"
read_when:
  - 你想在 OpenClaw 中使用 MiniMax 模型
  - 你需要 MiniMax 設定指南
title: "MiniMax"
---

# MiniMax

MiniMax 是一家 AI 公司，開發了 **M2/M2.1** 模型系列。當前專注於程式碼的發布版本是 **MiniMax M2.1** (2025 年 12 月 23 日)，專為現實世界中的複雜任務而建置。

來源：[MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## 模型總覽 (M2.1)

MiniMax 強調 M2.1 在以下方面有所改進：

- 更強大的**多語言程式碼**能力 (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS)。
- 更好的**網頁/應用程式開發**和美學輸出品質 (包括原生行動應用程式)。
- 改善了辦公室風格工作流程的**複合指令**處理，建立在交錯思維和整合約束執行之上。
- **更簡潔的回應**，降低了 token 使用量並加快了迭代循環。
- 更強大的**工具/智慧代理框架**相容性和上下文管理 (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox)。
- 更高品質的**對話和技術寫作**輸出。

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **速度：** Lightning 是 MiniMax 定價文件中的「快速」變體。
- **成本：** 定價顯示相同的輸入成本，但 Lightning 的輸出成本更高。
- **程式碼規劃路由：** Lightning 後端無法在 MiniMax 程式碼規劃中直接使用。MiniMax 會將大多數請求自動路由到 Lightning，但在流量高峰期間會回退到常規的 M2.1 後端。

## 選擇一個設定

### MiniMax OAuth (程式碼規劃) — 推薦

**最適合：** 透過 OAuth 快速設定 MiniMax 程式碼規劃，無需 API 金鑰。

啟用捆綁的 OAuth 插件並進行身份驗證：

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

系統將提示你選擇一個端點：

- **Global** - 國際使用者 (`api.minimax.io`)
- **CN** - 中國使用者 (`api.minimaxi.com`)

請參閱 [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) 了解詳情。

### MiniMax M2.1 (API 金鑰)

**最適合：** 託管的 MiniMax 與 Anthropic 相容的 API。

透過 CLI 設定：

- 執行 `openclaw configure`
- 選擇 **模型/auth**
- 選擇 **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 作為備用 (Opus 主要)

**最適合：** 保留 Opus 4.6 作為主要，故障轉移到 MiniMax M2.1。

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### 可選：透過 LM Studio 本機執行 (手動)

**最適合：** 使用 LM Studio 進行本機推論。
我們在使用 LM Studio 的本機伺服器在強大硬體 (例如桌上型電腦/伺服器) 上使用 MiniMax M2.1 時看到了不錯的結果。

透過 `openclaw.json` 手動設定：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
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

使用互動式設定精靈來設定 MiniMax，而無需編輯 JSON：

1.  執行 `openclaw configure`。
2.  選擇 **模型/auth**。
3.  選擇 **MiniMax M2.1**。
4.  在提示時選擇你的預設模型。

## 設定選項

- `models.providers.minimax.baseUrl`：偏好 `https://api.minimax.io/anthropic` (與 Anthropic 相容)；`https://api.minimax.io/v1` 可選用於 OpenAI 相容的負載。
- `models.providers.minimax.api`：偏好 `anthropic-messages`；`openai-completions` 可選用於 OpenAI 相容的負載。
- `models.providers.minimax.apiKey`：MiniMax API 金鑰 (`MINIMAX_API_KEY`)。
- `models.providers.minimax.models`：定義 `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost`。
- `agents.defaults.models`：為你要允許的模型設定別名。
- `models.mode`：如果你想將 MiniMax 與內建模型一起添加，請保留 `merge`。

## 注意事項

- 模型參考是 `minimax/<model>`。
- 程式碼規劃使用 API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (需要程式碼規劃金鑰)。
- 如果你需要精確的成本追蹤，請更新 `models.json` 中的定價值。
- MiniMax 程式碼規劃的推薦連結 (九折)：[https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 請參閱 [/concepts/model-providers](/concepts/model-providers) 了解供應商規則。
- 使用 `openclaw models list` 和 `openclaw models set minimax/MiniMax-M2.1` 進行切換。

## 疑難排解

### 「未知模型：minimax/MiniMax-M2.1」

這通常表示 **MiniMax 供應商未設定** (未找到供應商條目且未找到 MiniMax 身份驗證設定檔/環境變數金鑰)。此偵測的修復已在 **2026.1.12** 中 (撰寫本文時尚未發布)。修復方法：

- 升級到 **2026.1.12** (或從 `main` 原始碼執行)，然後重新啟動 Gateway。
- 執行 `openclaw configure` 並選擇 **MiniMax M2.1**，或者
- 手動添加 `models.providers.minimax` 區塊，或者
- 設定 `MINIMAX_API_KEY` (或 MiniMax 身份驗證設定檔)，以便注入供應商。

請確保模型 id **區分大小寫**：

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

然後使用以下命令重新檢查：

```bash
openclaw models list
```
