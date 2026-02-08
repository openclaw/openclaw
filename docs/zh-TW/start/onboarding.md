---
summary: 「OpenClaw（macOS 應用程式）的首次執行入門流程」
read_when:
  - 設計 macOS 入門引導助理時
  - 實作身分驗證或身分設定時
title: 「入門引導（macOS 應用程式）」
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:21Z
---

# 入門引導（macOS 應用程式）

本文件說明**目前**的首次執行入門引導流程。目標是提供順暢的「第 0 天」體驗：選擇 Gateway 閘道器 的執行位置、連接身分驗證、執行精靈，並讓代理程式自行完成啟動設定。

<Steps>
<Step title="核准 macOS 警告">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="核准尋找本地網路">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="歡迎畫面與安全性注意事項">
<Frame caption="請閱讀顯示的安全性注意事項並依情況決定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="本機或遠端">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway 閘道器** 在哪裡執行？

- **此 Mac（僅本機）：** 入門引導可以執行 OAuth 流程並在本機寫入認證資料。
- **遠端（透過 SSH/Tailnet）：** 入門引導**不會**在本機執行 OAuth；認證資料必須已存在於閘道器主機。
- **稍後設定：** 略過設定，讓應用程式保持未設定狀態。

<Tip>
**Gateway 閘道器 身分驗證提示：**
- 精靈現在即使在 loopback 情境下也會產生 **token**，因此本機 WS 用戶端必須進行身分驗證。
- 若停用身分驗證，任何本機程序都能連線；僅在完全受信任的機器上使用。
- 針對多機器存取或非 loopback 綁定，請使用 **token**。
</Tip>
</Step>
<Step title="權限">
<Frame caption="選擇要授予 OpenClaw 的權限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

入門引導會請求所需的 TCC 權限，包括：

- 自動化（AppleScript）
- 通知
- 輔助使用
- 螢幕錄製
- 麥克風
- 語音辨識
- 相機
- 位置資訊

</Step>
<Step title="CLI">
  <Info>此步驟為選用</Info>
  應用程式可透過 npm/pnpm 安裝全域的 `openclaw` CLI，讓終端機工作流程與 launchd 工作能立即使用。
</Step>
<Step title="入門引導聊天（專屬工作階段）">
  設定完成後，應用程式會開啟一個專屬的入門引導聊天工作階段，讓代理程式進行自我介紹並引導後續步驟。這可讓首次執行的引導與你的一般對話分開。請參閱 [Bootstrapping](/start/bootstrapping)，了解代理程式首次執行時在閘道器主機上發生的事項。
</Step>
</Steps>
