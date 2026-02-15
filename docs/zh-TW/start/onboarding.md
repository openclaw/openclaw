---
summary: "OpenClaw (macOS App) 的首次執行新手導覽流程"
read_when:
  - 設計 macOS 新手導覽助手時
  - 實作身分驗證或身分設定時
title: "新手導覽 (macOS App)"
sidebarTitle: "新手導覽：macOS App"
---

# 新手導覽 (macOS App)

本文件說明**目前**的首次執行新手導覽流程。目標是提供流暢的「第 0 天」體驗：選擇 Gateway 執行的位置、連接身分驗證、執行精靈，並讓智慧代理自行完成引導設定。
有關新手導覽路徑的一般總覽，請參閱 [新手導覽總覽](/start/onboarding-overview)。

<Steps>
<Step title="核准 macOS 警告">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="核准尋找區域網路">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="歡迎與安全性聲明">
<Frame caption="閱讀顯示的安全性聲明並據此決定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="本地與遠端">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** 在哪裡執行？

- **這台 Mac (僅限本地)：** 新手導覽可以執行 OAuth 流程並在本地寫入憑證。
- **遠端 (透過 SSH/Tailnet)：** 新手導覽**不會**在本地執行 OAuth；憑證必須存在於 Gateway 主機上。
- **稍後設定：** 跳過設定，讓 App 保持未設定狀態。

<Tip>
**Gateway 身分驗證提示：**
- 現在精靈即使針對 local loopback 也會產生 **token**，因此本地 WS 客戶端必須進行身分驗證。
- 如果您停用身分驗證，任何本地程序都可以連接；請僅在完全受信任的機器上使用此設定。
- 如需多機存取或非 loopback 繫結，請使用 **token**。
</Tip>
</Step>
<Step title="權限">
<Frame caption="選擇您想授予 OpenClaw 的權限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

新手導覽會請求所需的 TCC 權限，用於：

- 自動化 (AppleScript)
- 通知
- 輔助功能
- 螢幕錄製
- 麥克風
- 語音辨識
- 相機
- 位置

</Step>
<Step title="CLI">
  <Info>此步驟為選填</Info>
  App 可以透過 npm/pnpm 安裝全域 `openclaw` CLI，讓終端機工作流程和 launchd 任務開箱即用。
</Step>
<Step title="新手導覽對話 (專屬工作階段)">
  設定完成後，App 會開啟一個專屬的新手導覽對話工作階段，讓智慧代理進行自我介紹並引導後續步驟。這能將首次執行的引導與您的正常對話分開。有關智慧代理首次執行期間在 Gateway 主機上發生的情況，請參閱 [引導設定 (Bootstrapping)](/start/bootstrapping)。
</Step>
</Steps>
