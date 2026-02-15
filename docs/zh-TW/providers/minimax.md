---
summary: "在 OpenClaw 中使用 MiniMax M2.1"
read_when:
  - 您想在 OpenClaw 中使用 MiniMax 模型
  - 您需要 MiniMax 設定指南
title: "MiniMax"
---

# MiniMax

MiniMax 是一家開發 **M2/M2.1** 模型系列的 AI 公司。目前的程式開發導向版本為 **MiniMax M2.1**（2025 年 12 月 23 日發布），專為現實世界的複雜任務而設計。

來源：[MiniMax M2.1 發布日誌](https://www.minimax.io/news/minimax-m21)

## 模型概覽 (M2.1)

MiniMax 強調 M2.1 的以下改進：

- 更強大的**多語言程式開發**能力（Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS）。
- 更好的 **Web/App 開發**及美感輸出品質（包含原生行動端）。
- 改進了針對辦公流程的**複合指令**處理，基於交錯思考與整合約束執行。
- **更簡潔的回答**，具有更低的 Token 使用量和更快的疊代循環。
- 更強大的**工具/智慧代理框架**相容性與上下文管理（Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox）。
- 更高品質的**對話與技術寫作**輸出。

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **速度：** Lightning 是 MiniMax 價格文件中標註的「快速」變體。
- **成本：** 價格顯示輸入成本相同，但 Lightning 的輸出成本較高。
- **程式開發方案路由：** Lightning 後端無法直接在 MiniMax 程式開發方案中使用。MiniMax 會自動將大多數請求路由至 Lightning，但在流量高峰期間會回退至一般 M2.1 後端。

## 選擇設定方式

### MiniMax OAuth (程式開發方案) — 推薦

**最適合：** 透過 OAuth 快速設定 MiniMax 程式開發方案，不需要 API 金鑰。

啟用隨附的 OAuth 外掛程式並進行驗證：

```bash
openclaw plugins enable minimax-portal-auth  # 如果已載入則跳過
openclaw gateway restart  # 如果 Gateway 已在執行中請重啟
openclaw onboard --auth-choice minimax-portal
```

系統會提示您選擇端點 (endpoint)：

- **Global** - 國際用戶 (`api.minimax.io`)
- **CN** - 中國用戶 (`api.minimaxi.com`)

詳情請參閱 [MiniMax OAuth 外掛程式 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)。

### MiniMax M2.1 (API 金鑰)

**最適合：** 使用具備 Anthropic 相容 API 的託管型 MiniMax。

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

### MiniMax M2.1 作為回退模型 (Opus 為主)

**最適合：** 將 Opus 4.6 作為主要模型，並在失敗時回退至 MiniMax M2.1。

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

### 選用：透過 LM Studio 本機執行 (手動)

**最適合：** 使用 LM Studio 進行本機推論。
我們發現在強大的硬體（例如桌機/伺服器）上，配合 LM Studio 的本機伺服器使用 MiniMax M2.1 效果非常出色。

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

使用互動式設定精靈來設定 MiniMax，無需手動編輯 JSON：

1. 執行 `openclaw configure`。
2. 選擇 **Model/auth**。
3. 選擇 **MiniMax M2.1**。
4. 根據提示選擇您的預設模型。

## 設定選項

- `models.providers.minimax.baseUrl`：建議使用 `https://api.minimax.io/anthropic`（Anthropic 相容）；`https://api.minimax.io/v1` 則是 OpenAI 相容格式的選用項。
- `models.providers.minimax.api`：建議使用 `anthropic-messages`；`openai-completions` 則是 OpenAI 相容格式的選用項。
- `models.providers.minimax.apiKey`：MiniMax API 金鑰 (`MINIMAX_API_KEY`)。
- `models.providers.minimax.models`：定義 `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`。
- `agents.defaults.models`：為您想要列入允許清單的模型設定別名。
- `models.mode`：如果您想在內建模型之外新增 MiniMax，請保持為 `merge`。

## 注意事項

- 模型參照格式為 `minimax/<model>`。
- 程式開發方案使用量 API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（需要程式開發方案金鑰）。
- 如果您需要精確的成本追蹤，請更新 `models.json` 中的價格數值。
- MiniMax 程式開發方案推薦連結（10% 折扣）：[https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 供應商規則請參閱 [/concepts/model-providers](/concepts/model-providers)。
- 使用 `openclaw models list` 與 `openclaw models set minimax/MiniMax-M2.1` 進行切換。

## 疑難排解

### 「Unknown model: minimax/MiniMax-M2.1」

這通常代表 **MiniMax 供應商未設定**（找不到供應商項目、MiniMax 驗證設定檔或環境變數金鑰）。此偵測問題的修正程式包含在 **2026.1.12** 版本中（撰寫本文時尚未發布）。修正方法：

- 升級至 **2026.1.12**（或從 `main` 原始碼執行），然後重啟 Gateway。
- 執行 `openclaw configure` 並選擇 **MiniMax M2.1**，或
- 手動新增 `models.providers.minimax` 區塊，或
- 設定 `MINIMAX_API_KEY`（或 MiniMax 驗證設定檔），以便系統自動注入供應商。

請確保模型 ID **區分大小寫**：

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

然後使用以下指令重新檢查：

```bash
openclaw models list
```
