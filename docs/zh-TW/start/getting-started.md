```
---
summary: "在幾分鐘內安裝 OpenClaw 並運行您的第一次聊天。"
read_when:
  - 從零開始的首次設定
  - 您希望以最快的方式建立可運作的聊天
title: "入門指南"
---

# 入門指南

目標：以最少的設定，從零開始建立第一個可運作的聊天。

<Info>
最快速的聊天：開啟控制介面 (無需頻道設定)。運行 `openclaw dashboard` 並在瀏覽器中聊天，或者在 <Tooltip headline="Gateway 主機" tip="運行 OpenClaw Gateway 服務的機器。">Gateway 主機</Tooltip> 上開啟 `http://127.0.0.1:18789/`。
文件：[儀表板](/web/dashboard) 和 [控制介面](/web/control-ui)。
</Info>

## 先決條件

- Node 22 或更新版本

<Tip>
如果您不確定，請使用 `node --version` 檢查您的 Node 版本。
</Tip>

## 快速設定 (CLI)

<Steps>
  <Step title="安裝 OpenClaw (建議)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    其他安裝方法和要求：[安裝](/install)。
    </Note>

  </Step>
  <Step title="運行新手導覽精靈">
    ```bash
    openclaw onboard --install-daemon
    ```

    精靈會設定憑證、Gateway 設定和可選的頻道。詳情請參閱 [新手導覽精靈](/start/wizard)。

  </Step>
  <Step title="檢查 Gateway">
    如果您安裝了服務，它應該已經在運行：

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="開啟控制介面">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
如果控制介面載入，您的 Gateway 已可供使用。
</Check>

## 可選的檢查和額外項目

<AccordionGroup>
  <Accordion title="在前台運行 Gateway">
    對於快速測試或疑難排解很有用。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="傳送測試訊息">
    需要配置的頻道。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 有用的環境變數

如果您將 OpenClaw 作為服務帳戶運行，或者需要自訂設定/狀態位置：

- `OPENCLAW_HOME` 設定用於內部路徑解析的主目錄。
- `OPENCLAW_STATE_DIR` 覆寫狀態目錄。
- `OPENCLAW_CONFIG_PATH` 覆寫設定檔案路徑。

完整的環境變數參考：[環境變數](/help/environment)。

## 深入了解

<Columns>
  <Card title="新手導覽精靈 (詳情)" href="/start/wizard">
    完整的 CLI 精靈參考和進階選項。
  </Card>
  <Card title="macOS 應用程式新手導覽" href="/start/onboarding">
    macOS 應用程式的首次運行流程。
  </Card>
</Columns>

## 您將擁有什麼

- 一個正在運行的 Gateway
- 憑證已設定
- 控制介面存取權或一個已連接的頻道

## 後續步驟

- 私訊安全與核准：[配對](/channels/pairing)
- 連接更多頻道：[頻道](/channels)
- 進階工作流程和從源碼：[設定](/start/setup)
```
