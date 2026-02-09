---
summary: "在 OpenClaw 中使用 MiniMax M2.1"
read_when:
  - 你想在 OpenClaw 中使用 MiniMax 模型
  - 你需要 MiniMax 的設定指引
title: "MiniMax"
---

# MiniMax

MiniMax 是一家打造 **M2/M2.1** 模型系列的 AI 公司。目前以程式設計為重點的版本是 **MiniMax M2.1**（2025 年 12 月 23 日），專為真實世界的複雜任務而建。 The current
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for
real-world complex tasks.

來源：[MiniMax M2.1 發布說明](https://www.minimax.io/news/minimax-m21)

## 模型概覽（M2.1）

MiniMax 強調 M2.1 的以下改進：

- 更強的 **多語言程式設計**（Rust、Java、Go、C++、Kotlin、Objective-C、TS/JS）。
- Better **web/app development** and aesthetic output quality (including native mobile).
- 改善 **複合式指令** 的處理能力，適用於辦公室風格的工作流程，建立在交錯式思考與整合式約束執行之上。
- **更精簡的回應**，降低 token 使用量並加快迭代循環。
- 更強的 **工具／代理程式框架** 相容性與情境管理（Claude Code、Droid/Factory AI、Cline、Kilo Code、Roo Code、BlackBox）。
- 更高品質的 **對話與技術寫作** 輸出。

## MiniMax M2.1 與 MiniMax M2.1 Lightning

- **速度：** Lightning 是 MiniMax 定價文件中的「快速」變體。
- **成本：** 定價顯示輸入成本相同，但 Lightning 的輸出成本較高。
- **程式設計方案路由：** Lightning 後端無法直接用於 MiniMax 程式設計方案。MiniMax 會自動將大多數請求路由至 Lightning，但在流量尖峰時會回退到一般的 M2.1 後端。 MiniMax auto-routes most requests to Lightning, but falls back to the
  regular M2.1 back-end during traffic spikes.

## 選擇設定方式

### MiniMax OAuth（程式設計方案）— 建議

**最適合：** 透過 OAuth 快速設定 MiniMax 程式設計方案，無需 API 金鑰。

啟用隨附的 OAuth 外掛並進行驗證：

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

23. 系統會提示你選擇一個端點：

- **Global** - 國際使用者（`api.minimax.io`）
- **CN** - 中國使用者（`api.minimaxi.com`）

詳情請參閱 [MiniMax OAuth 外掛 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)。

### MiniMax M2.1（API 金鑰）

**最適合：** 使用具備 Anthropic 相容 API 的託管 MiniMax。

透過 CLI 設定：

- 執行 `openclaw configure`
- 選擇 **Model/auth**
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

### MiniMax M2.1 作為備援（Opus 為主要）

**最適合：** 以 Opus 4.6 為主要模型，故障時切換至 MiniMax M2.1。

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

### 選用：透過 LM Studio 的本地模式（手動）

24. **最適合：** 使用 LM Studio 進行本地推論。
    **最適合：** 使用 LM Studio 進行本地推論。
    我們在強大硬體（例如桌機／伺服器）上，透過 LM Studio 的本地伺服器使用 MiniMax M2.1，觀察到相當不錯的效果。

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

## 透過 `openclaw configure` 進行設定

使用互動式設定精靈來設定 MiniMax，而無需編輯 JSON：

1. 執行 `openclaw configure`。
2. 選擇 **Model/auth**。
3. 選擇 **MiniMax M2.1**。
4. 出現提示時選擇你的預設模型。

## 設定選項

- `models.providers.minimax.baseUrl`：建議使用 `https://api.minimax.io/anthropic`（Anthropic 相容）；`https://api.minimax.io/v1` 為 OpenAI 相容負載的選用項目。
- `models.providers.minimax.api`：建議使用 `anthropic-messages`；`openai-completions` 為 OpenAI 相容負載的選用項目。
- `models.providers.minimax.apiKey`：MiniMax API 金鑰（`MINIMAX_API_KEY`）。
- `models.providers.minimax.models`：定義 `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost`。
- `agents.defaults.models`：為你想加入允許清單的模型設定別名。
- `models.mode`：若你想將 MiniMax 與內建模型並存，請保留 `merge`。

## 注意事項

- 模型參照為 `minimax/<model>`。
- 程式設計方案使用 API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（需要程式設計方案金鑰）。
- 若需要精確的成本追蹤，請在 `models.json` 中更新定價數值。
- MiniMax 程式設計方案推薦連結（9 折）：[https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 提供者規則請參閱 [/concepts/model-providers](/concepts/model-providers)。
- 使用 `openclaw models list` 與 `openclaw models set minimax/MiniMax-M2.1` 來切換。

## Troubleshooting

### 「Unknown model: minimax/MiniMax-M2.1」

這通常表示 **MiniMax 提供者尚未設定**（沒有提供者項目，且找不到 MiniMax 的驗證設定檔或環境變數金鑰）。此偵測問題的修正將包含在 **2026.1.12**（撰寫時尚未發布）。解決方式如下： 26. 此偵測問題的修正在
**2026.1.12** 中（撰寫時尚未發布）。 27. 修正方式：

- 28. 升級至 **2026.1.12**（或從原始碼 `main` 執行），然後重新啟動 gateway。
- 執行 `openclaw configure` 並選擇 **MiniMax M2.1**，或
- 手動新增 `models.providers.minimax` 區塊，或
- 設定 `MINIMAX_API_KEY`（或 MiniMax 驗證設定檔），以便注入提供者。

請確認模型 ID **區分大小寫**：

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

接著重新檢查：

```bash
openclaw models list
```
