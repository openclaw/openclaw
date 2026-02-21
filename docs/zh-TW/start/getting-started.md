---
summary: "在幾分鐘內安裝好 OpenClaw 並開始第一次聊天。"
read_when:
  - 從零開始進行首次設定
  - 你想要最快路徑進入可運作的聊天環境
title: "入門指南"
---

# 入門指南

目標：以最少的設定，從零開始進入第一個可運作的聊天環境。

<Info>
最速對話：開啟控制台 (無需設定通訊頻道)。執行 `openclaw dashboard`
並在瀏覽器中聊天，或者在
<Tooltip headline="Gateway 主機" tip="執行 OpenClaw Gateway 服務的機器。">Gateway 主機</Tooltip> 上開啟 `http://127.0.0.1:18789/`。
相關文件：[儀表板](/web/dashboard) 與 [控制台 (Control UI)](/web/control-ui)。
</Info>

## 前置需求

- Node 22 或更新版本

<Tip>
如果你不確定，請使用 `node --version` 檢查你的 Node 版本。
</Tip>

## 快速設定 (CLI)

<Steps>
  <Step title="安裝 OpenClaw (推薦)">
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
    其他安裝方法與需求：[安裝](/install)。
    </Note>

  </Step>
  <Step title="執行上線精靈">
    ```bash
    openclaw onboard --install-daemon
    ```

    精靈將引導你設定身分驗證、Gateway 設定以及選配的通訊頻道。
    詳情請參閱 [上線精靈](/start/wizard)。

  </Step>
  <Step title="檢查 Gateway">
    如果你安裝了服務，它現在應該已經在運行中：

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="開啟控制台">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
如果控制台成功載入，表示你的 Gateway 已準備就緒。
</Check>

## 選配檢查與額外功能

<AccordionGroup>
  <Accordion title="在前台執行 Gateway">
    適用於快速測試或故障排除。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="發送測試訊息">
    需要至少設定一個通訊頻道。

    ```bash
    openclaw message send --target +15555550123 --message "來自 OpenClaw 的問候"
    ```

  </Accordion>
</AccordionGroup>

## 有用的環境變數

如果你將 OpenClaw 作為服務帳號運行，或想要自定義設定檔/狀態儲存位置：

- `OPENCLAW_HOME` 設定內部路徑解析使用的家目錄。
- `OPENCLAW_STATE_DIR` 覆蓋狀態目錄位置。
- `OPENCLAW_CONFIG_PATH` 覆蓋設定檔路徑。

完整環境變數參考：[環境變數](/help/environment)。

## 進階閱讀

<Columns>
  <Card title="上線精靈 (詳情)" href="/start/wizard">
    完整的 CLI 精靈參考與進階選項。
  </Card>
  <Card title="macOS App 上線引導" href="/start/onboarding">
    macOS App 的首次執行流程。
  </Card>
</Columns>

## 你將獲得什麼

- 一個運行中的 Gateway
- 已完成身分驗證設定
- 控制台存取權限或已連接的通訊頻道

## 後續步驟

- 私訊安全與批准：[配對 (Pairing)](/channels/pairing)
- 連接更多頻道：[通訊頻道](/channels)
- 進階工作流與從源碼建置：[開發設定](/start/setup)
