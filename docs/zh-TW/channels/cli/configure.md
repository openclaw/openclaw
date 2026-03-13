---
summary: CLI reference for `openclaw configure` (interactive configuration prompts)
read_when:
  - "You want to tweak credentials, devices, or agent defaults interactively"
title: configure
---

# `openclaw configure`

[[BLOCK_1]] 互動提示以設置憑證、設備和代理預設值。 [[BLOCK_1]]

注意：**模型**部分現在包含一個多選項的 `agents.defaults.models` 允許清單（顯示在 `/model` 和模型選擇器中）。

提示：`openclaw config` 不帶子命令會打開相同的精靈。使用 `openclaw config get|set|unset` 進行非互動式編輯。

[[BLOCK_1]]

- Gateway 設定參考: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

[[BLOCK_1]]

- 選擇 Gateway 執行的位置會始終更新 `gateway.mode`。如果這是您所需的全部內容，您可以選擇「繼續」而不需其他部分。
- 以頻道為導向的服務（Slack/Discord/Matrix/Microsoft Teams）在設置過程中會提示輸入頻道/房間的允許清單。您可以輸入名稱或 ID；精靈會在可能的情況下將名稱解析為 ID。
- 如果您執行守護進程安裝步驟，則 token 認證需要一個 token，而 `gateway.auth.token` 是由 SecretRef 管理的，設定會驗證 SecretRef，但不會將解析後的明文 token 值持久化到監督服務的環境元數據中。
- 如果 token 認證需要一個 token 且設定的 token SecretRef 尚未解析，則設定會阻止守護進程安裝並提供可行的修復指導。
- 如果 `gateway.auth.token` 和 `gateway.auth.password` 都已設定且 `gateway.auth.mode` 未設置，則設定會阻止守護進程安裝，直到模式被明確設置。

## Examples

```bash
openclaw configure
openclaw configure --section model --section channels
```
