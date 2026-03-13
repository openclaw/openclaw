---
summary: Get OpenClaw installed and run your first chat in minutes.
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: Getting Started
---

# 快速開始

目標：從零開始，透過最少設定完成第一個可用的聊天。

<Info>
最快速的聊天方式：開啟 Control UI（不需設定頻道）。執行 `openclaw dashboard`，即可在瀏覽器中聊天，或在
<Tooltip headline="Gateway host" tip="執行 OpenClaw gateway 服務的主機。">gateway host</Tooltip> 上開啟 `http://127.0.0.1:18789/`。
文件：請參考 [Dashboard](/web/dashboard) 與 [Control UI](/web/control-ui)。
</Info>

## 前置需求

- 建議使用 Node 24（Node 22 LTS，目前為 `22.16+`，仍支援相容性）

<Tip>
如果不確定，請用 `node --version` 檢查你的 Node 版本。
</Tip>

## 快速設定（CLI）

<Steps>
  <Step title="安裝 OpenClaw（推薦）">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="安裝腳本流程"
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
    其他安裝方式與需求請參考：[Install](/install)。
    </Note>

</Step>
  <Step title="執行入門精靈">
    ```bash
    openclaw onboard --install-daemon
    ```

此精靈會設定認證、gateway 設定及可選頻道。
詳細內容請見 [Onboarding Wizard](/start/wizard)。

</Step>
  <Step title="檢查 Gateway">
    如果你已安裝服務，應該已經在執行中：

````bash
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
如果 Control UI 成功載入，代表你的 Gateway 已準備就緒。
</Check>

## 選用檢查與額外功能

<AccordionGroup>
  <Accordion title="在前景執行 Gateway">
    適合快速測試或故障排除。

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

如果你以服務帳號執行 OpenClaw，或想自訂設定/狀態位置：

- `OPENCLAW_HOME` 設定用於內部路徑解析的家目錄。
- `OPENCLAW_STATE_DIR` 覆寫狀態目錄。
- `OPENCLAW_CONFIG_PATH` 覆寫設定檔路徑。

完整環境變數參考：[Environment vars](/help/environment)。

## 深入了解

<Columns>
  <Card title="入門精靈（詳細）" href="/start/wizard">
    完整 CLI 精靈參考與進階選項。
  </Card>
  <Card title="macOS 應用程式入門" href="/start/onboarding">
    macOS 應用程式首次執行流程。
  </Card>
</Columns>

## 你將擁有

- 一個正在執行的 Gateway
- 已設定的認證
- 控制 UI 存取權限或已連接的頻道

## 下一步

- DM 安全性與審核： [配對](/channels/pairing)
- 連接更多頻道： [頻道](/channels)
- 進階工作流程與來源設定： [設定](/start/setup)
````
