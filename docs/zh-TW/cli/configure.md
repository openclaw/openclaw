---
summary: "`openclaw configure` 的 CLI 參考（互動式設定提示）」"
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
title: "設定"
---

# `openclaw configure`

Interactive prompt to set up credentials, devices, and agent defaults.

注意：**Model** 區段現在包含 `agents.defaults.models` 允許清單的多選項（顯示於 `/model` 與模型選擇器中）。

提示：不加子命令執行 `openclaw config` 會開啟相同的精靈。若需非互動式編輯，請使用 `openclaw config get|set|unset`。 Use
`openclaw config get|set|unset` for non-interactive edits.

Related:

- Gateway 設定參考：[設定](/gateway/configuration)
- 設定 CLI：[設定](/cli/config)

注意事項：

- 選擇 Gateway 執行位置時，總是會更新 `gateway.mode`。若你只需要這一步，可在不設定其他區段的情況下選擇「Continue」。 You can select "Continue" without other sections if that is all you need.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.

## 範例

```bash
openclaw configure
openclaw configure --section models --section channels
```
