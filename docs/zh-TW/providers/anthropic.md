---
summary: "在 OpenClaw 中透過 API 金鑰或 setup-token 使用 Anthropic Claude"
read_when:
  - 您想在 OpenClaw 中使用 Anthropic 模型
  - 您想使用 setup-token 而非 API 金鑰
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic 開發了 **Claude** 模型系列，並提供透過 API 存取的方式。
在 OpenClaw 中，您可以透過 API 金鑰或 **setup-token** 進行驗證。

## 選項 A：Anthropic API 金鑰

**最適合：** 標準 API 存取與按量計費。
請在 Anthropic Console 中建立您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard
# 選擇：Anthropic API key

# 或使用非互動式指令
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 設定程式碼片段

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt 快取 (Anthropic API)

OpenClaw 支援 Anthropic 的 prompt 快取功能。這僅限 **API 存取**；訂閱制驗證不支援快取設定。

### 設定

在您的模型設定中使用 `cacheRetention` 參數：

| 數值    | 快取持續時間 | 描述                       |
| ------- | ------------ | -------------------------- |
| `none`  | 不快取       | 停用 prompt 快取           |
| `short` | 5 分鐘       | API 金鑰驗證的預設值       |
| `long`  | 1 小時       | 延長快取（需要 beta flag） |

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

使用 Anthropic API 金鑰驗證時，OpenClaw 會自動為所有 Anthropic 模型套用 `cacheRetention: "short"`（5 分鐘快取）。您可以透過在設定中明確指定 `cacheRetention` 來覆蓋此設定。

### 舊版參數

為了回溯相容，仍支援舊有的 `cacheControlTtl` 參數：

- `"5m"` 對應到 `short`
- `"1h"` 對應到 `long`

我們建議遷移至新的 `cacheRetention` 參數。

OpenClaw 的 Anthropic API 請求已包含 `extended-cache-ttl-2025-04-11` beta flag；如果您覆蓋了供應商標頭（請參閱 [/gateway/configuration](/gateway/configuration)），請保留此 flag。

## 選項 B：Claude setup-token

**最適合：** 使用您的 Claude 訂閱。

### 如何取得 setup-token

setup-token 是由 **Claude Code CLI** 建立的，而非 Anthropic Console。您可以在**任何機器**上執行：

```bash
claude setup-token
```

將權杖貼上至 OpenClaw（精靈：**Anthropic token (paste setup-token)**），或在 Gateway 主機上執行：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您是在不同機器上產生的權杖，請直接貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 設定 (setup-token)

```bash
# 在新手導覽期間貼上 setup-token
openclaw onboard --auth-choice setup-token
```

### 設定程式碼片段 (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 注意事項

- 使用 `claude setup-token` 產生 setup-token 並貼上，或在 Gateway 主機上執行 `openclaw models auth setup-token`。
- 如果您在 Claude 訂閱上看到「OAuth token refresh failed ...」，請使用 setup-token 重新進行驗證。請參閱 [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)。
- 驗證詳情與重複使用規則請參閱 [/concepts/oauth](/concepts/oauth)。

## 疑難排解

**401 錯誤 / 權杖突然失效**

- Claude 訂閱驗證可能會過期或遭撤銷。請重新執行 `claude setup-token` 並貼上至 **Gateway 主機**。
- 如果 Claude CLI 登入資訊位於不同機器，請在 Gateway 主機上使用 `openclaw models auth paste-token --provider anthropic`。

**找不到供應商 "anthropic" 的 API 金鑰**

- 驗證是**針對智慧代理**的。新的智慧代理不會繼承主智慧代理的金鑰。
- 為該智慧代理重新執行新手導覽，或在 Gateway 主機上貼上 setup-token / API 金鑰，然後使用 `openclaw models status` 進行驗證。

**找不到設定檔 `anthropic:default` 的憑證**

- 執行 `openclaw models status` 查看目前啟用的驗證設定檔。
- 重新執行新手導覽，或為該設定檔貼上 setup-token / API 金鑰。

**無可用的驗證設定檔（皆處於冷卻中/不可用）**

- 檢查 `openclaw models status --json` 中的 `auth.unusableProfiles`。
- 新增另一個 Anthropic 設定檔或等待冷卻時間結束。

更多資訊：[/gateway/troubleshooting](/gateway/troubleshooting) 與 [/help/faq](/help/faq)。
