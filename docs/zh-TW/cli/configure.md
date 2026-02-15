---
summary: "`openclaw configure` 的 CLI 參考指南（互動式設定提示）"
read_when:
  - 當您想要以互動方式調整憑證、裝置或智慧代理預設值時
title: "configure"
---

# `openclaw configure`

用於設定憑證、裝置和智慧代理預設值的互動式提示。

注意：**模型 (Model)** 區段現在包含 `agents.defaults.models` 允許清單的多選功能（即顯示在 `/model` 和模型選擇器中的內容）。

提示：不帶子指令的 `openclaw config` 也會開啟相同的精靈。若要進行非互動式編輯，請使用 `openclaw config get|set|unset`。

相關內容：

- Gateway 設定參考：[設定](/gateway/configuration)
- Config CLI：[Config](/cli/config)

備註：

- 選擇 Gateway 執行的位置一律會更新 `gateway.mode`。如果您只需要進行此項設定，可以不選擇其他區段直接點選「繼續 (Continue)」。
- 導向頻道 (Channel) 的服務（Slack/Discord/Matrix/Microsoft Teams）在設定期間會提示輸入頻道/聊天室的允許清單。您可以輸入名稱或 ID；精靈會在可能的情況下將名稱解析為 ID。

## 範例

```bash
openclaw configure
openclaw configure --section models --section channels
```
