---
summary: "CLI 參考，用於 `openclaw configure` (互動式設定提示)"
read_when:
  - 當您想要互動式地調整憑證、裝置或智慧代理預設值時
title: "設定"
---

# `openclaw configure`

設定憑證、裝置和智慧代理預設值的互動式提示。

注意：**模型**區塊現在包含適用於 `agents.defaults.models` 允許清單的多選功能（將會顯示在 `/model` 和模型選擇器中）。

提示：不帶子指令的 `openclaw config` 會開啟相同的精靈。使用 `openclaw config get|set|unset` 進行非互動式編輯。

相關：

- Gateway 設定參考：[設定](/gateway/configuration)
- 設定 CLI：[設定](/cli/config)

注意事項：

- 選擇 Gateway 執行位置總是會更新 `gateway.mode`。如果您只需要這樣，可以選擇「繼續」而不選擇其他區塊。
- 頻道導向服務 (Slack/Discord/Matrix/Microsoft Teams) 在設定期間會提示您輸入頻道/房間允許清單。您可以輸入名稱或 ID；精靈會盡可能將名稱解析為 ID。

## 範例

```bash
openclaw configure
openclaw configure --section models --section channels
```
