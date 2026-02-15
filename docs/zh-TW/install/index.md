---
summary: "安裝 OpenClaw — 安裝程式腳本、npm/pnpm、從原始碼、Docker 等"
read_when:
  - 你需要入門指南快速開始以外的安裝方法
  - 你想部署到雲端平台
  - 你需要更新、遷移或解除安裝
title: "安裝"
---

# 安裝

已經依照[入門指南](/start/getting-started)操作了嗎？你已經準備就緒 — 本頁提供其他安裝方法、平台專屬說明和維護資訊。

## 系統需求

- **[Node 22+](/install/node)** (若遺失，[安裝程式腳本](#install-methods)將會安裝它)
- macOS、Linux 或 Windows
- 只有從原始碼建置時才需要 `pnpm`

<Note>
在 Windows 上，我們強烈建議在 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 下執行 OpenClaw。
</Note>

## 安裝方法

<Tip>
**安裝程式腳本** 是安裝 OpenClaw 的推薦方式。它能一步到位地處理 Node 偵測、安裝和新手導覽。
</Tip>

<AccordionGroup>
  <Accordion title="安裝程式腳本" icon="rocket" defaultOpen>
    下載 CLI，透過 npm 全域安裝，並啟動新手導覽精靈。

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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

    就是這麼簡單 — 該腳本會處理 Node 偵測、安裝和新手導覽。

    若要跳過新手導覽並只安裝二進位檔案：

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    關於所有旗標、環境變數以及 CI/自動化選項，請參閱[安裝程式內部機制](/install/installer)。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    如果你已經有 Node 22+，並且偏好自行管理安裝：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp 建置錯誤？">
          如果你已全域安裝 libvips (在 macOS 上透過 Homebrew 很常見)，且 `sharp` 失敗，請強制使用預先建置的二進位檔案：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
          ```

          如果你看到 `sharp: Please add node-gyp to your dependencies`，請安裝建置工具 (macOS: Xcode CLT + `npm install -g node-gyp`) 或使用上方環境變數。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm 針對具有建置腳本的套件需要明確批准。初次安裝後，如果顯示「Ignored build scripts」警告，請執行 `pnpm approve-builds -g` 並選擇列出的套件。
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="從原始碼" icon="github">
    適用於貢獻者或任何想從本地端簽出執行的人。

    <Steps>
      <Step title="複製並建置">
        複製 [OpenClaw 儲存庫](https://github.com/openclaw/openclaw) 並建置：

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="連結 CLI">
        讓 `openclaw` 命令全域可用：

        ```bash
        pnpm link --global
        ```

        或者，跳過連結並從儲存庫內部透過 `pnpm openclaw ...` 執行命令。
      </Step>
      <Step title="執行新手導覽">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    對於更深入的開發工作流程，請參閱[設定](/start/setup)。

  </Accordion>
</AccordionGroup>

## 其他安裝方法

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    容器化或無頭部署。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    透過 Nix 進行宣告式安裝。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化機群佈建。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    透過 Bun 執行時僅限 CLI 使用。
  </Card>
</CardGroup>

## 安裝後

驗證一切運作正常：

```bash
openclaw doctor         # 檢查設定問題
openclaw status         # Gateway 狀態
openclaw dashboard      # 開啟瀏覽器 UI
```

如果你需要自訂執行時路徑，請使用：

- `OPENCLAW_HOME` 用於基於主目錄的內部路徑
- `OPENCLAW_STATE_DIR` 用於可變狀態位置
- `OPENCLAW_CONFIG_PATH` 用於設定檔案位置

請參閱[環境變數](/help/environment)以了解優先順序和完整詳情。

## 疑難排解：`openclaw` 找不到

<Accordion title="PATH 診斷與修復">
  快速診斷：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

如果 `$(npm prefix -g)/bin` (macOS/Linux) 或 `$(npm prefix -g)` (Windows) **不在**你的 `$PATH` 中，你的 shell 無法找到全域 npm 二進位檔案 (包括 `openclaw`)。

修復 — 將其新增到你的 shell 啟動檔案 (`~/.zshrc` 或 `~/.bashrc`)：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

在 Windows 上，將 `npm prefix -g` 的輸出新增到你的 PATH。

然後開啟一個新的終端機 (或在 zsh 中執行 `rehash` / 在 bash 中執行 `hash -r`)。
</Accordion>

## 更新 / 解除安裝

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    保持 OpenClaw 為最新版本。
  </Card>
  <Card title="遷移" href="/install/migrating" icon="arrow-right">
    遷移到新機器。
  </Card>
  <Card title="解除安裝" href="/install/uninstall" icon="trash-2">
    完全移除 OpenClaw。
  </Card>
</CardGroup>
