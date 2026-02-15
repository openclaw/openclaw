---
summary: "Gateway 服務、生命週期與營運維護指南"
read_when:
  - 執行或偵錯 Gateway 程序時
title: "Gateway 營運維護指南"
---

# Gateway 營運維護指南

本頁面提供 Gateway 服務的第一天啟動與第二天營運維護說明。

<CardGroup cols={2}>
  <Card title="進階疑難排解" icon="siren" href="/gateway/troubleshooting">
    以症狀為導向的診斷，包含精確的指令步驟與日誌特徵。
  </Card>
  <Card title="設定" icon="sliders" href="/gateway/configuration">
    以任務為導向的設定指南 + 完整的設定參考資料。
  </Card>
</CardGroup>

## 5 分鐘本地啟動

<Steps>
  <Step title="啟動 Gateway">

```bash
openclaw gateway --port 18789
# 將偵錯/追蹤資訊輸出至標準輸出
openclaw gateway --port 18789 --verbose
# 強制終止所選連接埠上的監聽程式，然後啟動
openclaw gateway --force
```

  </Step>

  <Step title="驗證服務狀態">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

健康基準：`Runtime: running` 且 `RPC probe: ok`。

  </Step>

  <Step title="驗證頻道就緒狀態">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gateway 設定重新載入會監控使用中的設定檔案路徑（由 profile/狀態預設值解析，或使用設定好的 `OPENCLAW_CONFIG_PATH`）。
預設模式為 `gateway.reload.mode="hybrid"`。
</Note>

## 執行階段模型

- 一個常駐程序負責路由、控制平面與頻道連線。
- 單一多工連接埠用於：
  - WebSocket 控制/RPC
  - HTTP API（OpenAI 相容、回應、工具調用）
  - 控制 UI 與 hooks
- 預設綁定模式：`loopback`。
- 預設需要身分驗證（`gateway.auth.token` / `gateway.auth.password`，或 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）。

### 連接埠與綁定優先順序
