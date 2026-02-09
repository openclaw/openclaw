---
summary: "在 OpenClaw 中透過 API 金鑰或 setup-token 使用 Anthropic Claude"
read_when:
  - 你想在 OpenClaw 中使用 Anthropic 模型
  - 你想使用 setup-token 而非 API 金鑰
title: "Anthropic"
---

# Anthropic（Claude）

Anthropic 建構 **Claude** 模型家族，並透過 API 提供存取。
在 OpenClaw 中，你可以使用 API 金鑰或 **setup-token** 進行身分驗證。
In OpenClaw you can authenticate with an API key or a **setup-token**.

## 選項 A：Anthropic API 金鑰

**Best for:** standard API access and usage-based billing.
**最適合：** 標準 API 存取與依用量計費。
請在 Anthropic Console 建立你的 API 金鑰。

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

## 提示詞快取（Anthropic API）

OpenClaw supports Anthropic's prompt caching feature. This is **API-only**; subscription auth does not honor cache settings.

### 設定

在你的模型設定中使用 `cacheRetention` 參數：

| 值       | Cache Duration | Description            |
| ------- | -------------- | ---------------------- |
| `none`  | No caching     | Disable prompt caching |
| `short` | 5 分鐘           | API 金鑰驗證的預設值           |
| `long`  | 1 小時           | 延長快取（需要 beta 旗標）       |

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

### Defaults

使用 Anthropic API 金鑰驗證時，OpenClaw 會自動為所有 Anthropic 模型套用 `cacheRetention: "short"`（5 分鐘快取）。你可以在設定中明確設定 `cacheRetention` 以覆寫此行為。 You can override this by explicitly setting `cacheRetention` in your config.

### Legacy parameter

較舊的 `cacheControlTtl` 參數仍支援以維持向後相容性：

- `"5m"` 對應至 `short`
- `"1h"` 對應至 `long`

我們建議遷移至新的 `cacheRetention` 參數。

OpenClaw 在 Anthropic API 請求中包含 `extended-cache-ttl-2025-04-11` beta 旗標；若你覆寫提供者標頭，請保留它（參見 [/gateway/configuration](/gateway/configuration)）。

## 選項 B：Claude setup-token

**最適合：** 使用你的 Claude 訂閱。

### 取得 setup-token 的位置

Setup-token 由 **Claude Code CLI** 建立，而非 Anthropic Console。你可以在 **任何機器** 上執行： You can run this on **any machine**:

```bash
claude setup-token
```

將權杖貼到 OpenClaw（精靈：**Anthropic token（貼上 setup-token）**），或在閘道器主機上執行：

```bash
openclaw models auth setup-token --provider anthropic
```

如果你在不同的機器上產生了權杖，請貼上它：

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

- 使用 `claude setup-token` 產生 setup-token 並貼上，或在閘道器主機上執行 `openclaw models auth setup-token`。
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token. 若在 Claude 訂閱中看到「OAuth token refresh failed …」，請使用 setup-token 重新驗證。請參閱 [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)。
- 驗證細節與重用規則請見 [/concepts/oauth](/concepts/oauth)。

## Troubleshooting

**401 錯誤／權杖突然失效**

- Claude subscription auth can expire or be revoked. Re-run `claude setup-token`
  and paste it into the **gateway host**.
- 若 Claude CLI 登入存在於不同的機器上，請在閘道器主機上使用
  `openclaw models auth paste-token --provider anthropic`。

**找不到提供者「anthropic」的 API 金鑰**

- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- 重新為該代理程式執行入門引導，或在閘道器主機上貼上 setup-token／API 金鑰，然後使用 `openclaw models status` 驗證。

**找不到設定檔 `anthropic:default` 的認證**

- 執行 `openclaw models status` 以查看目前啟用的驗證設定檔。
- Re-run onboarding, or paste a setup-token / API key for that profile.

**No available auth profile (all in cooldown/unavailable)**

- 檢查 `openclaw models status --json` 是否為 `auth.unusableProfiles`。
- 新增另一個 Anthropic 設定檔，或等待冷卻結束。

更多內容：[/gateway/troubleshooting](/gateway/troubleshooting) 與 [/help/faq](/help/faq)。
