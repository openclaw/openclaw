---
summary: 「`openclaw configure` 的 CLI 參考（互動式設定提示）」」
read_when:
  - 「當你想以互動方式微調認證、裝置或代理程式預設值時」
title: 「設定」
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:17Z
---

# `openclaw configure`

用於設定認證、裝置與代理程式預設值的互動式提示。

注意：**Model** 區段現在包含 `agents.defaults.models` 允許清單的多選項（顯示於 `/model` 與模型選擇器中）。

提示：不加子命令執行 `openclaw config` 會開啟相同的精靈。若需非互動式編輯，請使用 `openclaw config get|set|unset`。

相關：

- Gateway 設定參考：[設定](/gateway/configuration)
- 設定 CLI：[設定](/cli/config)

注意事項：

- 選擇 Gateway 執行位置時，總是會更新 `gateway.mode`。若你只需要這一步，可在不設定其他區段的情況下選擇「Continue」。
- 以頻道為導向的服務（Slack/Discord/Matrix/Microsoft Teams）在設定期間會提示輸入頻道／房間的允許清單。你可以輸入名稱或 ID；精靈會在可能時將名稱解析為 ID。

## 範例

```bash
openclaw configure
openclaw configure --section models --section channels
```
