---
summary: "OpenClaw (macOS 應用程式) 的首次執行新手導覽流程"
read_when:
  - 設計 macOS 新手導覽助理時
  - 實作認證或身分設定時
title: "新手導覽 (macOS 應用程式)"
sidebarTitle: "新手導覽：macOS 應用程式"
---

# 新手導覽 (macOS 應用程式)

這份文件描述了**目前**的首次執行新手導覽流程。目標是提供流暢的「第 0 天」體驗：選擇 Gateway 的執行位置、連線認證、執行精靈，並讓智慧代理自行啟動。有關新手導覽路徑的總體概述，請參閱 [新手導覽總覽](/start/onboarding-overview)。

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
<Step title="歡迎與安全注意事項">
<Frame caption="閱讀顯示的安全注意事項並據此決定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="本地 vs 遠端">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Gateway 在何處執行？

- **此 Mac (僅限本地):** 新手導覽可以在本地執行 OAuth 流程並寫入憑證。
- **遠端 (透過 SSH/Tailnet):** 新手導覽**不會**在本地執行 OAuth；憑證必須存在於 Gateway 主機上。
- **稍後設定:** 跳過設定並讓應用程式保持未設定狀態。

<Tip>
**Gateway 認證提示:**
- 精靈現在即使對於 local loopback 也會生成一個 **權杖**，因此本地 WS 用戶端必須進行認證。
- 如果您停用認證，任何本地行程都可以連線；僅在完全受信任的機器上使用此功能。
- 使用 **權杖** 進行多機存取或非 loopback 綁定。
</Tip>
</Step>
<Step title="權限">
<Frame caption="選擇您要授予 OpenClaw 的權限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

新手導覽請求所需的 TCC 權限包括：

- 自動化 (AppleScript)
- 通知
- 輔助使用
- 螢幕錄影
- 麥克風
- 語音辨識
- 相機
- 定位

</Step>
<Step title="CLI">
  <Info>此步驟為選填</Info>
  應用程式可以透過 npm/pnpm 安裝全域的 `openclaw` CLI，以便終端機工作流程和 launchd 任務可以直接使用。
</Step>
<Step title="新手導覽聊天 (專用工作階段)">
  設定完成後，應用程式會開啟一個專用的新手導覽聊天工作階段，以便智慧代理可以自我介紹並引導後續步驟。這使得首次執行的指南與您的日常對話分開。有關智慧代理首次執行期間在 Gateway 主機上發生的情況，請參閱 [啟動](/start/bootstrapping)。
</Step>
</Steps>
