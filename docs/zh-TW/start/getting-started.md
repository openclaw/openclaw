---
summary: "在幾分鐘內完成 OpenClaw 安裝並開始您的第一次對話。"
read_when:
  - 從零開始進行首次設定
  - 您想以最快路徑開始對話
title: "入門指南"
---

# 入門指南

目標：以最少的設定從零開始完成第一次對話。

<Info>
最快開始對話的方式：開啟 Control UI（不需要設定頻道）。執行 `openclaw dashboard` 並在瀏覽器中進行對話，或在 <Tooltip headline="Gateway host" tip="執行 OpenClaw Gateway 服務的機器。">Gateway 主機</Tooltip>上開啟 `http://127.0.0.1:18789/`。
文件：[Dashboard](/web/dashboard) 與 [Control UI](/web/control-ui)。
</Info>

## 前置需求

- Node 22 或更高版本

<Tip>
如果不確定，請使用 `node --version` 檢查您的 Node 版本。
</Tip>

## 快速設定 (CLI)

<Steps>
  <Step title="安裝 OpenClaw (建議使用)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="安裝指令碼流程"
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
    其他安裝方法與需求：[安裝](/install)。
    </Note>

  </Step>
  <Step title="執行新手導覽精靈">
    ```bash
    openclaw onboard --install-daemon
    ```

    精靈將引導您完成憑證、Gateway 設定以及選用的頻道設定。
    詳情請參閱 [新手導覽精靈](/start/wizard)。

  </Step>
  <Step title="檢查 Gateway">
    如果您已安裝該服務，它應該已經在執行中：

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
如果 Control UI 成功載入，表示您的 Gateway 已準備就緒。
</Check>

## 選用檢查與額外功能

<AccordionGroup>
  <Accordion title="在前台執行 Gateway">
    適用於快速測試或疑難排解。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="發送測試訊息">
    需要已設定的頻道。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 有用的環境變數

如果您以服務帳戶執行 OpenClaw，或想要自訂設定/狀態位置：

- `OPENCLAW_HOME` 設定用於內部路徑解析的主目錄。
- `OPENCLAW_STATE_DIR` 覆蓋狀態目錄。
- `OPENCLAW_CONFIG_PATH` 覆蓋設定檔案路徑。

完整的環境變數參考：[環境變數](/help/environment)。

## 深入瞭解

<Columns>
  <Card title="新手導覽精靈 (詳情)" href="/start/wizard">
    完整的 CLI 精靈參考與進階選項。
  </Card>
  <Card title="macOS 應用程式新手導覽" href="/start/onboarding">
    macOS 應用程式的首次執行流程。
  </Card>
</Columns>

## 您將獲得

- 執行中的 Gateway
- 已設定憑證
- Control UI 存取權限或已連線的頻道

## 後續步驟

- 私訊安全與授權：[Pairing](/channels/pairing)
- 連結更多頻道：[Channels](/channels)
- 進階工作流與從原始碼安裝：[Setup](/start/setup)
