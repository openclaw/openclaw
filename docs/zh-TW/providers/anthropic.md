---
summary: Use Anthropic Claude via API keys or setup-token in OpenClaw
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want setup-token instead of API keys
title: Anthropic
---

# Anthropic (Claude)

Anthropic 建構了 **Claude** 模型系列，並透過 API 提供存取服務。  
在 OpenClaw 中，你可以使用 API key 或 **setup-token** 進行驗證。

## 選項 A：Anthropic API key

**適用於：** 標準 API 存取與依使用量計費。  
請在 Anthropic 控制台建立你的 API key。

### CLI 設定

bash
openclaw onboard

# 選擇：Anthropic API key

# 或非互動模式

openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"

### 設定範例

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 預設思考模式（Claude 4.6）

- Anthropic Claude 4.6 模型在 OpenClaw 中，若未明確設定思考層級，預設為 `adaptive`。
- 你可以針對每則訊息 (`/think:<level>`) 或在模型參數中覆寫：  
  `agents.defaults.models["anthropic/<model>"].params.thinking`。
- 相關 Anthropic 文件：
  - [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
  - [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## 快速模式（Anthropic API）

OpenClaw 的共用 `/fast` 切換也支援直接使用 Anthropic API key 的流量。

- `/fast on` 對應到 `service_tier: "auto"`
- `/fast off` 對應到 `service_tier: "standard_only"`
- 預設設定：

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5": {
          params: { fastMode: true },
        },
      },
    },
  },
}
```

重要限制：

- 僅限 **API-key** 使用。Anthropic 的 setup-token / OAuth 認證不支援 OpenClaw 快速模式階層注入。
- OpenClaw 僅對直接 `api.anthropic.com` 請求注入 Anthropic 服務階層。若你透過代理或閘道路由 `anthropic/*`，`/fast` 將保持 `service_tier` 不變。
- Anthropic 會在回應的 `usage.service_tier` 中回報實際使用的階層。對於沒有優先階層容量的帳號，`service_tier: "auto"` 仍可能解析為 `standard`。

## 提示快取（Anthropic API）

OpenClaw 支援 Anthropic 的提示快取功能。此功能僅限 **API** 使用；訂閱認證不支援快取設定。

### 設定

請在你的模型設定中使用 `cacheRetention` 參數：

| 值      | 快取時長 | 說明                       |
| ------- | -------- | -------------------------- |
| `none`  | 不快取   | 停用提示快取               |
| `short` | 5 分鐘   | API Key 認證的預設值       |
| `long`  | 1 小時   | 延長快取（需啟用測試旗標） |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### 預設值

使用 Anthropic API Key 認證時，OpenClaw 會自動對所有 Anthropic 模型套用 `cacheRetention: "short"`（5 分鐘快取）。你可以在設定中明確指定 `cacheRetention` 來覆寫此預設。

### 針對代理的 cacheRetention 覆寫

以模型層級參數作為基準，再透過 `agents.list[].params` 覆寫特定代理的設定。

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // baseline for most agents
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // override for this agent only
    ],
  },
}
```

快取相關參數的設定合併順序：

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（符合 `id`，以 key 覆寫）

這讓一個代理可以維持長期快取，而同一模型上的另一個代理則關閉快取，以避免在突發性或低重用率流量時產生寫入成本。

### Bedrock Claude 註記

- Bedrock 上的 Anthropic Claude 模型 (`amazon-bedrock/*anthropic.claude*`) 在設定時接受 `cacheRetention` 直通。
- 非 Anthropic 的 Bedrock 模型在執行時被強制 `cacheRetention: "none"`。
- Anthropic API 金鑰的智能預設值也會為 Claude-on-Bedrock 模型參考設定 `cacheRetention: "short"`，當沒有明確設定值時。

### 舊版參數

舊版的 `cacheControlTtl` 參數仍支援以維持向後相容：

- `"5m"` 對應到 `short`
- `"1h"` 對應到 `long`

我們建議遷移至新的 `cacheRetention` 參數。

OpenClaw 包含 Anthropic API 請求的 `extended-cache-ttl-2025-04-11` 測試旗標；如果你覆寫提供者標頭（參見 [/gateway/configuration](/gateway/configuration)），請保留此旗標。

## 1M 上下文視窗（Anthropic 測試版）

Anthropic 的 1M 上下文視窗為測試版功能。在 OpenClaw 中，針對支援的 Opus/Sonnet 模型，透過 `params.context1m: true` 啟用。

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OpenClaw 會將此映射到 Anthropic 請求的 `anthropic-beta: context-1m-2025-08-07`。

此功能僅在該模型明確設定 `params.context1m` 為 `true` 時啟用。

需求：Anthropic 必須允許該憑證使用長上下文（通常是 API 金鑰計費，或啟用額外使用量的訂閱帳號）。否則 Anthropic 會回傳：
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`。

注意：Anthropic 目前在使用 OAuth/訂閱 token (`sk-ant-oat-*`) 時會拒絕 `context-1m-*` 測試版請求。OpenClaw 會自動跳過 OAuth 認證的 context1m 測試版標頭，並保留必要的 OAuth 測試版標頭。

## 選項 B：Claude setup-token

**適用對象：** 使用您的 Claude 訂閱。

### 取得 setup-token 的位置

Setup-token 是由 **Claude Code CLI** 產生的，而非 Anthropic Console。您可以在 **任何機器** 上執行：

```bash
claude setup-token
```

將 token 貼到 OpenClaw（精靈：**Anthropic token（貼上 setup-token）**），或在 gateway 主機上執行：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您是在其他機器產生 token，請貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 設定（setup-token）

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### 設定片段（setup-token）

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 注意事項

- 使用 `claude setup-token` 產生 setup-token 並貼上，或在 gateway 主機上執行 `openclaw models auth setup-token`。
- 如果在 Claude 訂閱中看到「OAuth token refresh failed …」錯誤，請使用 setup-token 重新認證。詳見 [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)。
- 認證細節與重複使用規則請參考 [/concepts/oauth](/concepts/oauth)。

## 疑難排解

**401 錯誤 / token 突然失效**

- Claude 訂閱授權可能會過期或被撤銷。請重新執行 `claude setup-token`，並將結果貼到 **gateway host**。
- 如果 Claude CLI 登入是在不同機器上，請在 gateway host 使用 `openclaw models auth paste-token --provider anthropic`。

**找不到提供者 "anthropic" 的 API key**

- 授權是 **每個代理人** 獨立的。新代理人不會繼承主代理人的金鑰。
- 請重新執行該代理人的 onboarding，或在 gateway host 貼上 setup-token / API key，然後用 `openclaw models status` 驗證。

**找不到 `anthropic:default` 設定檔的憑證**

- 執行 `openclaw models status` 查看目前啟用的授權設定檔。
- 重新執行 onboarding，或為該設定檔貼上 setup-token / API key。

**沒有可用的授權設定檔（全部在冷卻中或不可用）**

- 檢查 `openclaw models status --json` 中的 `auth.unusableProfiles`。
- 新增另一個 Anthropic 設定檔或等待冷卻結束。

更多資訊請參考：[/gateway/troubleshooting](/gateway/troubleshooting) 與 [/help/faq](/help/faq)。
