---
summary: Gateway dashboard (Control UI) access and auth
read_when:
  - Changing dashboard authentication or exposure modes
title: Dashboard
---

# 儀表板（控制介面）

Gateway 儀表板是預設由 `/` 提供的瀏覽器控制介面  
（可用 `gateway.controlUi.basePath` 覆寫）。

快速開啟（本地 Gateway）：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（或 [http://localhost:18789/](http://localhost:18789/)）

重要參考：

- [控制介面](/web/control-ui) 用於使用說明與介面功能。
- [Tailscale](/gateway/tailscale) 用於 Serve/Funnel 自動化。
- [Web 介面](/web) 關於綁定模式與安全性說明。

認證在 WebSocket 握手階段透過 `connect.params.auth` 強制執行（token 或密碼）。  
詳見 [Gateway 設定](/gateway/configuration) 中的 `gateway.auth`。

安全提醒：控制介面是 **管理端介面**（聊天、設定、執行批准）。  
請勿公開暴露。介面會將儀表板 URL token 保存在 sessionStorage 中，僅限當前瀏覽器分頁會話及所選 Gateway URL，並在載入後從 URL 中移除。  
建議使用 localhost、Tailscale Serve 或 SSH 隧道。

## 快速路徑（推薦）

- 完成初始設定後，CLI 會自動開啟儀表板並列印乾淨（無 token）連結。
- 隨時重新開啟：`openclaw dashboard`（複製連結，若可開啟瀏覽器則開啟，無頭模式顯示 SSH 提示）。
- 若介面要求認證，請將 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）的 token 貼到控制介面設定中。

## Token 基礎（本地 vs 遠端）

- **本地端**：開啟 `http://127.0.0.1:18789/`。
- **Token 來源**：`gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）；`openclaw dashboard` 可透過 URL fragment 傳遞一次性啟動 token，控制介面會將其保存在 sessionStorage 中，限定當前瀏覽器分頁會話及所選 Gateway URL，而非 localStorage。
- 若 `gateway.auth.token` 是 SecretRef 管理，`openclaw dashboard` 預設會列印／複製／開啟無 token 的 URL，避免在 shell 日誌、剪貼簿歷史或瀏覽器啟動參數中暴露外部管理的 token。
- 若 `gateway.auth.token` 設為 SecretRef 且在當前 shell 中未解析，`openclaw dashboard` 仍會列印無 token URL 並提供可執行的認證設定指引。
- **非本地端**：使用 Tailscale Serve（若 `gateway.auth.allowTailscale: true`，控制介面／WebSocket 無需 token，假設 Gateway 主機可信；HTTP API 仍需 token／密碼）、tailnet 綁定帶 token，或 SSH 隧道。詳見 [Web 介面](/web)。

## 若出現 “unauthorized” / 1008

- 確認 Gateway 可連線（本地端：`openclaw status`；遠端：先 SSH 隧道 `ssh -N -L 18789:127.0.0.1:18789 user@host`，再開啟 `http://127.0.0.1:18789/`）。
- 對於 `AUTH_TOKEN_MISMATCH`，當 Gateway 回傳重試提示時，用戶端可能會用快取的裝置 token 進行一次受信任的重試。若重試後仍認證失敗，請手動解決 token 偏移問題。
- token 偏移修復步驟，請參考 [Token 偏移恢復檢查清單](/cli/devices#token-drift-recovery-checklist)。
- 從 Gateway 主機取得或提供 token：
  - 明文設定：`openclaw config get gateway.auth.token`
  - SecretRef 管理設定：解析外部秘密提供者或在此 shell 匯出 `OPENCLAW_GATEWAY_TOKEN`，然後重新執行 `openclaw dashboard`
  - 未設定 token：`openclaw doctor --generate-gateway-token`
- 在儀表板設定中，將 token 貼入認證欄位，然後連線。
