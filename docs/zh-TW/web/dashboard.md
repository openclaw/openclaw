---
summary: "Gateway 閘道器儀表板（Control UI）的存取與身分驗證"
read_when:
  - 變更儀表板身分驗證或暴露模式時
title: "Dashboard"
---

# Dashboard（Control UI）

Gateway 閘道器儀表板是瀏覽器中的 Control UI，預設於 `/` 提供服務
（可透過 `gateway.controlUi.basePath` 覆寫）。

快速開啟（本機 Gateway 閘道器）：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（或 [http://localhost:18789/](http://localhost:18789/)）

33. 關鍵參考：

- [Control UI](/web/control-ui)：使用方式與 UI 功能。
- [Tailscale](/gateway/tailscale)：Serve／Funnel 自動化。
- [Web surfaces](/web)：綁定模式與安全性注意事項。

身分驗證在 WebSocket 交握時透過 `connect.params.auth` 強制執行
（權杖或密碼）。請參閱 [Gateway 設定](/gateway/configuration) 中的 `gateway.auth`。 34. 請參閱 [Gateway configuration](/gateway/configuration) 中的 `gateway.auth`。

3. 安全注意事項：Control UI 是一個 **管理介面**（聊天、設定、執行核准）。
4. 請勿公開對外暴露。 37. UI 會在首次載入後將權杖儲存在 `localStorage` 中。
5. 建議使用 localhost、Tailscale Serve，或 SSH 通道。

## 快速路徑（建議）

- 完成入門引導後，CLI 會自動開啟儀表板，並列印乾淨（未含權杖）的連結。
- 隨時重新開啟：`openclaw dashboard`（複製連結、可行時開啟瀏覽器，無頭模式時顯示 SSH 提示）。
- 若 UI 要求身分驗證，請將 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）中的權杖貼到 Control UI 設定中。

## 39. 權杖基礎（本機 vs 遠端）

- **Localhost**：開啟 `http://127.0.0.1:18789/`。
- **權杖來源**：`gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）；連線後 UI 會在 localStorage 中儲存一份副本。
- **非 localhost**：使用 Tailscale Serve（若 `gateway.auth.allowTailscale: true` 則無需權杖）、以權杖進行 tailnet 綁定，或使用 SSH 通道。請參閱 [Web surfaces](/web)。 40. 請參閱 [Web surfaces](/web)。

## 若看到「unauthorized」／1008

- 確認 Gateway 閘道器可達（本機：`openclaw status`；遠端：先建立 SSH 通道 `ssh -N -L 18789:127.0.0.1:18789 user@host`，再開啟 `http://127.0.0.1:18789/`）。
- 從閘道器主機取得權杖：`openclaw config get gateway.auth.token`（或產生新的：`openclaw doctor --generate-gateway-token`）。
- 9. 在儀表板設定中，將權杖貼到驗證欄位，然後連線。
