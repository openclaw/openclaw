---
summary: "Gateway 控制面板 (控制使用者介面) 存取與驗證"
read_when:
  - 變更控制面板驗證或公開模式時
title: "控制面板"
---

# 控制面板 (控制使用者介面)

Gateway 控制面板是瀏覽器控制使用者介面，預設在 `/` 提供服務
(可透過 `gateway.controlUi.basePath` 覆寫)。

快速開啟 (本機 Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (或 [http://localhost:18789/](http://localhost:18789/))

重要參考資訊:

- [Control UI](/web/control-ui) 以了解使用方式和使用者介面功能。
- [Tailscale](/gateway/tailscale) 以了解 Serve/Funnel 自動化。
- [網頁介面](/web) 以了解綁定模式和安全性注意事項。

驗證在 WebSocket 握手期間強制執行，透過 `connect.params.auth`
(權杖或密碼)。請參閱 [Gateway 設定](/gateway/configuration) 中的 `gateway.auth`。

安全性注意事項: 控制使用者介面是**管理員介面** (聊天、設定、執行核准)。
請勿公開。使用者介面在首次載入後會將權杖儲存在 `localStorage` 中。
建議使用 localhost、Tailscale Serve 或 SSH 通道。

## 快速路徑 (建議)

- 新手導覽完成後，CLI 會自動開啟控制面板並列印一個乾淨的 (未權杖化的) 連結。
- 隨時重新開啟: `openclaw dashboard` (複製連結，如果可能則開啟瀏覽器，如果為無頭模式則顯示 SSH 提示)。
- 如果使用者介面提示驗證，請將 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`) 中的權杖貼上到控制使用者介面設定中。

## 權杖基礎知識 (本機與遠端)

- **Localhost**: 開啟 `http://127.0.0.1:18789/`。
- **權杖來源**: `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`); 使用者介面在您連線後會在 localStorage 中儲存一個副本。
- **非 localhost**: 使用 Tailscale Serve (如果 `gateway.auth.allowTailscale: true` 則無需權杖)、使用權杖綁定 tailnet，或 SSH 通道。請參閱 [網頁介面](/web)。

## 如果您看到「未經授權」/ 1008

- 確保 Gateway 可到達 (本機: `openclaw status`; 遠端: SSH 通道 `ssh -N -L 18789:127.0.0.1:18789 user @host` 然後開啟 `http://127.0.0.1:18789/`)。
- 從 Gateway 主機檢索權杖: `openclaw config get gateway.auth.token` (或產生一個: `openclaw doctor --generate-gateway-token`)。
- 在控制面板設定中，將權杖貼到驗證欄位，然後連線。
