---
summary: "在幾分鐘內安裝 OpenClaw 並執行你的第一個聊天。"
read_when:
  - 從零開始的首次設定
  - 你想要最快速地完成可用聊天
title: "入門指南"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:15Z
---

# 入門指南

目標：以最少的設定，從零開始到第一個可運作的聊天。

<Info>
最快速的聊天方式：開啟 Control UI（不需要設定頻道）。執行 `openclaw dashboard`
並在瀏覽器中聊天，或在
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">閘道器主機</Tooltip>
上開啟 `http://127.0.0.1:18789/`。
文件： [Dashboard](/web/dashboard) 與 [Control UI](/web/control-ui)。
</Info>

## 先決條件

- Node 22 或更新版本

<Tip>
如果不確定，請使用 `node --version` 檢查你的 Node 版本。
</Tip>

## 快速設定（CLI）

<Steps>
  <Step title="安裝 OpenClaw（建議）">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows（PowerShell）">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    其他安裝方式與需求請參考： [Install](/install)。
    </Note>

  </Step>
  <Step title="執行入門引導精靈">
    ```bash
    openclaw onboard --install-daemon
    ```

    精靈會設定身分驗證、Gateway 閘道器設定，以及選用的頻道。
    詳情請參閱 [Onboarding Wizard](/start/wizard)。

  </Step>
  <Step title="檢查 Gateway 閘道器">
    如果你已安裝服務，它應該已經在執行中：

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="開啟 Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
如果 Control UI 能成功載入，表示你的 Gateway 閘道器已準備好使用。
</Check>

## 選用檢查與附加項目

<AccordionGroup>
  <Accordion title="以前景模式執行 Gateway 閘道器">
    適合快速測試或疑難排解。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="傳送測試訊息">
    需要已設定的頻道。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 深入了解

<Columns>
  <Card title="入門引導精靈（詳細說明）" href="/start/wizard">
    完整的 CLI 精靈參考與進階選項。
  </Card>
  <Card title="macOS 應用程式入門引導" href="/start/onboarding">
    macOS 應用程式首次執行流程。
  </Card>
</Columns>

## 你將會擁有

- 一個正在執行的 Gateway 閘道器
- 已設定的身分驗證
- Control UI 存取權或已連接的頻道

## 後續步驟

- 私訊安全與核准： [Pairing](/channels/pairing)
- 連接更多頻道： [Channels](/channels)
- 進階工作流程與從原始碼開始： [Setup](/start/setup)
