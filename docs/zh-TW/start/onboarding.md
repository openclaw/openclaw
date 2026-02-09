---
summary: "OpenClaw（macOS 應用程式）的首次執行入門流程"
read_when:
  - 設計 macOS 入門引導助理時
  - Implementing auth or identity setup
title: "入門引導（macOS 應用程式）"
sidebarTitle: "Onboarding: macOS App"
---

# 入門引導（macOS 應用程式）

This doc describes the **current** first‑run onboarding flow. 7. 目標是一個
順暢的「第 0 天」體驗：選擇 Gateway 的執行位置、連接驗證、執行精靈，並讓代理自行完成啟動。

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="請閱讀顯示的安全性注意事項並依情況決定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway 閘道器** 在哪裡執行？

- 8. **此 Mac（僅限本機）：** 導覽流程可以執行 OAuth 流程並在本機寫入憑證。
- **遠端（透過 SSH/Tailnet）：** 入門引導**不會**在本機執行 OAuth；認證資料必須已存在於閘道器主機。
- **稍後設定：** 略過設定，讓應用程式保持未設定狀態。

<Tip>
9. **Gateway 驗證提示：**
- 精靈現在即使在 loopback 情況下也會產生一個 **token**，因此本機 WS 用戶端必須進行驗證。
- If you disable auth, any local process can connect; use that only on fully trusted machines.
- 對於多機器存取或非 loopback 綁定，請使用 **token**。
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="選擇要授予 OpenClaw 的權限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

入門引導會請求所需的 TCC 權限，包括：

- 自動化（AppleScript）
- 通知
- 無障礙
- 螢幕錄製
- 麥克風
- 語音辨識
- 相機
- 位置資訊

</Step>
<Step title="CLI">
  <Info>14. 此步驟為選用</Info>
  應用程式可透過 npm/pnpm 安裝全域的 `openclaw` CLI，讓終端機工作流程與 launchd 工作能立即使用。
</Step>
<Step title="Onboarding Chat (dedicated session)">
  設定完成後，應用程式會開啟一個專用的新手引導聊天工作階段，讓代理
  自我介紹並引導後續步驟。 這能讓首次執行的引導內容
  與你的一般對話分開。 請參閱 [Bootstrapping](/start/bootstrapping)，了解
  在第一次代理執行期間，閘道主機上會發生什麼事。
</Step>
</Steps>
