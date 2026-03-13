---
summary: First-run onboarding flow for OpenClaw (macOS app)
read_when:
  - Designing the macOS onboarding assistant
  - Implementing auth or identity setup
title: Onboarding (macOS App)
sidebarTitle: "Onboarding: macOS App"
---

# 新手引導（macOS 應用程式）

本文檔說明了**目前**的首次啟動新手引導流程。目標是提供順暢的「第 0 天」體驗：選擇 Gateway 執行位置、連接認證、執行精靈，並讓代理程式自動啟動。
如需新手引導路徑的一般概述，請參考 [新手引導總覽](/start/onboarding-overview)。

<Steps>
<Step title="批准 macOS 警告">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="批准尋找本地網路">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="歡迎與安全通知">
<Frame caption="閱讀顯示的安全通知並做出相應決定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

安全信任模型：

- 預設情況下，OpenClaw 是個人代理：單一受信任操作邊界。
- 共享/多用戶環境需要鎖定（分割信任邊界，保持工具存取最小化，並遵循 [安全](/gateway/security) 指南）。
- 本地新手引導現在預設新設定為 `tools.profile: "coding"`，讓全新本地環境保留檔案系統/執行時工具，而不強制使用無限制的 `full` 設定檔。
- 若啟用 hooks/webhooks 或其他不受信任的內容來源，請使用強健的現代模型層級，並保持嚴格的工具政策與沙箱機制。

</Step>
<Step title="本地 vs 遠端">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** 執行在哪裡？

- **此 Mac（僅本地）：** 新手引導可設定認證並在本地寫入憑證。
- **遠端（透過 SSH/Tailnet）：** 新手引導**不會**設定本地認證；憑證必須存在於 Gateway 主機上。
- **稍後設定：** 跳過設定，讓應用程式保持未設定狀態。

<Tip>
**Gateway 認證小提示：**

- 精靈現在即使是迴圈回路也會產生**token**，因此本地 WS 用戶端必須驗證身份。
- 若您停用認證，任何本地程序都能連線；此設定僅適用於完全受信任的機器。
- 多機存取或非迴圈回路綁定時，請使用**token**。

</Tip>
</Step>
<Step title="權限">
<Frame caption="選擇您想授予 OpenClaw 的權限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

新手引導會請求以下 TCC 權限：

- 自動化（AppleScript）
- 通知
- 輔助功能
- 螢幕錄製
- 麥克風
- 語音辨識
- 相機
- 位置

</Step>
<Step title="CLI">
  <Info>此步驟為選用</Info>
  應用程式可透過 npm/pnpm 安裝全域 `openclaw` CLI，讓終端機工作流程與 launchd 任務開箱即用。
</Step>
<Step title="新手引導聊天（專屬會話）">
  設定完成後，應用程式會開啟專屬的新手引導聊天會話，讓代理程式自我介紹並引導後續步驟。這樣能將首次使用指引與您平常的對話分開。請參考 [啟動流程](/start/bootstrapping) 了解代理程式首次執行時 Gateway 主機上的行為。
</Step>
</Steps>
