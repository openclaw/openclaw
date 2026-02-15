---
summary: "Gateway Dashboard (控制介面) 存取與認證"
read_when:
  - 更改 Dashboard 認證或公開模式時
title: "Dashboard"
---

# Dashboard (控制介面)

Gateway Dashboard 是預設在 `/` 路徑提供的瀏覽器控制介面 (控制介面) (可透過 `gateway.controlUi.basePath` 覆寫)。

快速開啟 (本地 Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (或 [http://localhost:18789/](http://localhost:18789/))

重點參考：

- [控制介面](/web/control-ui) 了解用法與 UI 功能。
- [Tailscale](/gateway/tailscale) 了解 Serve/Funnel 自動化。
- [Web surfaces](/web) 了解綁定模式與安全性說明。

認證是在 WebSocket 握手階段透過 `connect.params.auth` (Token 或密碼) 強制執行的。請參閱 [Gateway 設定](/gateway/configuration) 中的 `gateway.auth`。

安全性說明：控制介面是一個 **管理介面** (聊天、設定、執行核准)。請勿將其公開。UI 在首次載入後會將 Token 儲存在 `localStorage` 中。建議優先使用 localhost、Tailscale Serve 或 SSH 通道。

## 快速路徑 (建議使用)

- 完成新手導覽後，CLI 會自動開啟 Dashboard 並列印一個乾淨的 (不含 Token) 連結。
- 隨時重新開啟：`openclaw dashboard` (會複製連結，若可行則開啟瀏覽器，若為無頭模式則顯示 SSH 提示)。
- 如果 UI 提示需要認證，請將 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`) 中的 Token 貼入控制介面設定中。

## Token 基礎知識 (本地 vs 遠端)

- **Localhost**：開啟 `http://127.0.0.1:18789/`。
- **Token 來源**：`gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)；UI 在你連接後會於 `localStorage` 儲存一份副本。
- **非 localhost**：使用 Tailscale Serve (若 `gateway.auth.allowTailscale: true` 則無需 Token)、帶有 Token 的 tailnet 綁定，或 SSH 通道。請參閱 [Web surfaces](/web)。

## 如果你看到 “unauthorized” / 1008

- 確保 Gateway 可連線 (本地：`openclaw status`；遠端：SSH 通道 `ssh -N -L 18789:127.0.0.1:18789 user@host` 然後開啟 `http://127.0.0.1:18789/`)。
- 從 Gateway 主機取得 Token：`openclaw config get gateway.auth.token` (或生成一個：`openclaw doctor --generate-gateway-token`)。
- 在 Dashboard 設定中，將 Token 貼入認證欄位，然後進行連線。
