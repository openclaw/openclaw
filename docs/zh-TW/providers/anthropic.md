---
summary: "使用 Anthropic Claude 透過 API 金鑰或 setup-token 於 OpenClaw 中"
read_when:
  - 您想在 OpenClaw 中使用 Anthropic 模型
  - 您想使用 setup-token 而非 API 金鑰
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic 建立了 **Claude** 模型家族，並透過 API 提供存取。
在 OpenClaw 中，您可以透過 API 金鑰或 **setup-token** 進行驗證。

## 選項 A: Anthropic API 金鑰

**最適合：** 標準 API 存取與依用量計費。
在 Anthropic 控制台建立您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 設定片段

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 提示快取 (Anthropic API)

OpenClaw 支援 Anthropic 的提示快取功能。這僅限於 **API**；訂閱驗證不會遵循快取設定。

### 設定

在您的模型設定中使用 `cacheRetention` 參數：

| 值      | 快取持續時間 | 說明                              |
| ------- | -------------- | --------------------------------- |
| `none`  | 無快取         | 停用提示快取                        |
| `short` | 5 分鐘         | API 金鑰驗證的預設值                 |
| `long`  | 1 小時         | 延長快取（需要 Beta 旗標）         |

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

使用 Anthropic API 金鑰驗證時，OpenClaw 會自動對所有 Anthropic 模型套用 `cacheRetention: "short"`（5 分鐘快取）。您可以透過在您的設定中明確設定 `cacheRetention` 來覆寫此設定。

### 舊版參數

較舊的 `cacheControlTtl` 參數仍支援向後相容：

- `"5m"` 對應到 `short`
- `"1h"` 對應到 `long`

我們建議遷移到新的 `cacheRetention` 參數。

OpenClaw 包含 Anthropic API 請求的 `extended-cache-ttl-2025-04-11` beta 旗標；如果您覆寫供應商標頭（請參閱 [/gateway/configuration](/gateway/configuration)），請保留它。

## 選項 B: Claude setup-token

**最適合：** 使用您的 Claude 訂閱。

### 如何取得 setup-token

setup-token 是由 **Claude Code CLI** 建立的，而不是 Anthropic 控制台。您可以在**任何機器**上執行此命令：

```bash
claude setup-token
```

將 token 貼到 OpenClaw 中（精靈：**Anthropic token (貼上 setup-token)**），或在 Gateway 主機上執行：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您在不同的機器上生成了 token，請貼上它：

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 設定 (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### 設定片段 (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 備註

- 使用 `claude setup-token` 生成 setup-token 並貼上它，或在 Gateway 主機上執行 `openclaw models auth setup-token`。
- 如果您在 Claude 訂閱上看到「OAuth token refresh failed …」，請使用 setup-token 重新驗證。請參閱 [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)。
- 驗證詳細資訊 + 重複使用規則位於 [/concepts/oauth](/concepts/oauth)。

## 疑難排解

**401 錯誤 / token 突然失效**

- Claude 訂閱驗證可能會過期或被撤銷。重新執行 `claude setup-token`
  並將其貼到 **Gateway 主機**中。
- 如果 Claude CLI 登入位於不同的機器上，請在 Gateway 主機上使用
  `openclaw models auth paste-token --provider anthropic`。

**未找到提供者 "anthropic" 的 API 金鑰**

- 驗證是**按智慧代理**進行的。新的智慧代理不會繼承主要智慧代理的金鑰。
- 重新執行該智慧代理的新手導覽，或在 Gateway 主機上貼上 setup-token / API 金鑰，
  然後使用 `openclaw models status` 進行驗證。

**未找到設定檔 `anthropic:default` 的憑證**

- 執行 `openclaw models status` 以查看哪個驗證設定檔處於啟用狀態。
- 重新執行新手導覽，或為該設定檔貼上 setup-token / API 金鑰。

**無可用的驗證設定檔 (全部處於冷卻/不可用狀態)**

- 檢查 `openclaw models status --json` 中的 `auth.unusableProfiles`。
- 新增另一個 Anthropic 設定檔或等待冷卻時間結束。

更多資訊：[/gateway/troubleshooting](/gateway/troubleshooting) 和 [/help/faq](/help/faq)。
