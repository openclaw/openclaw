---
summary: "在幾分鐘內安裝 OpenClaw 並執行你的第一個聊天。"
read_when:
  - 從零開始的首次設定
  - 你想要最快速地完成可用聊天
title: "入門指南"
---

# 入門指南

目標：以最少的設定，從零開始到第一個可運作的聊天。

<Info>

最快速的聊天方式：開啟 Control UI（不需要設定頻道）。執行 `openclaw dashboard`
並在瀏覽器中聊天，或在
 Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway 主機</Tooltip>.

上開啟 `http://127.0.0.1:18789/`。
文件： [Dashboard](/web/dashboard) 與 [Control UI](/web/control-ui)。

</Info>

## Prereqs

- Node 22 或更新版本

<Tip>
如果不確定，請使用 `node --version` 檢查你的 Node 版本。
</Tip>

## 快速設定（CLI）

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    ```
    <Note>
    其他安裝方式與需求請參考： [Install](/install)。
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    15. 精靈會設定驗證、gateway 設定，以及可選的頻道。詳情請見 [Onboarding Wizard](/start/wizard)。
    ```

  </Step>
  <Step title="Check the Gateway">
    如果你已安裝服務，它應該已經在執行中：

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    適合快速測試或疑難排解。

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    需要已設定的頻道。

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## 深入了解

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Full CLI wizard reference and advanced options.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS 應用程式首次執行流程。
  </Card>
</Columns>

## What you will have

- 一個正在執行的 Gateway 閘道器
- 18. 已設定完成的驗證
- Control UI 存取權或已連接的頻道

## 後續步驟

- 私訊安全與核准： [Pairing](/channels/pairing)
- 連接更多頻道： [Channels](/channels)
- 進階工作流程與從原始碼開始： [Setup](/start/setup)
