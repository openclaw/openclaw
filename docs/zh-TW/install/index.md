---
summary: "安裝 OpenClaw — 安裝指令碼、npm/pnpm、原始碼編譯、Docker 等方式"
read_when:
  - 當您需要入門指南快速開始以外的安裝方式時
  - 當您想要部署到雲端平台時
  - 當您需要更新、遷移或卸載時
title: "安裝"
---

<!-- markdownlint-disable MD051 -->

# 安裝

已經按照過 [入門指南](/start/getting-started) 了嗎？那您已經準備就緒 — 本頁面提供其他安裝方法、特定平台的說明以及維護資訊。

## 系統需求

- **[Node 22+](/install/node)** (如果缺少，[安裝指令碼](#install-methods) 會自動安裝)
- macOS, Linux, 或 Windows
- 僅在您從原始碼建置時需要 `pnpm`

<Note>
在 Windows 上，我們強烈建議在 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 下執行 OpenClaw。
</Note>

## 安裝方式

<Tip>
**安裝指令碼** 是安裝 OpenClaw 的推薦方式。它能一鍵處理 Node 偵測、安裝和新手導覽。
</Tip>

<AccordionGroup>
  <Accordion title="安裝指令碼" icon="rocket" defaultOpen>
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

    就這樣 — 該指令碼會處理 Node 偵測、安裝和新手導覽。

    若要跳過新手導覽並僅安裝執行檔：

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

    有關所有旗標、環境變數和 CI/自動化選項，請參閱 [安裝程式內部原理](/install/installer)。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    如果您已經安裝了 Node 22+ 並希望自行管理安裝：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw @latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp 建置錯誤？">
          如果您已在全域安裝 libvips（在 macOS 透過 Homebrew 很常見）且 `sharp` 失敗，請強制使用預編譯的二進位檔案：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw @latest
          ```

          如果您看到 `sharp: Please add node-gyp to your dependencies`，請安裝建置工具（macOS：Xcode CLT + `npm install -g node-gyp`）或使用上述環境變數。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw @latest
        pnpm approve-builds -g        # 核准 openclaw, node-llama-cpp, sharp 等
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm 需要對包含建置指令碼的套件進行顯式核准。在首次安裝顯示「Ignored build scripts」警告後，請執行 `pnpm approve-builds -g` 並選擇列出的套件。
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="從原始碼安裝" icon="github">
    適用於貢獻者或任何想要從本地檢出版本執行的人。

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
        使 `openclaw` 指令可在全域使用：

        ```bash
        pnpm link --global
        ```

        或者，跳過連結並直接在儲存庫內透過 `pnpm openclaw ...` 執行指令。
      </Step>
      <Step title="執行新手導覽">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    如需更深入的開發工作流，請參閱 [設定](/start/setup)。

  </Accordion>
</AccordionGroup>

## 其他安裝方式

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    容器化或無前端（headless）部署。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    透過 Nix 進行宣告式安裝。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化集群配置。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    透過 Bun 執行環境僅限 CLI 使用。
  </Card>
</CardGroup>

## 安裝後

驗證一切運作正常：

```bash
openclaw doctor         # 檢查設定問題
openclaw status         # Gateway 狀態
openclaw dashboard      # 開啟瀏覽器 UI
```

如果您需要自定義執行路徑，請使用：

- `OPENCLAW_HOME` 用於基於家目錄的內部路徑
- `OPENCLAW_STATE_DIR` 用於可變狀態位置
- `OPENCLAW_CONFIG_PATH` 用於設定檔案位置

請參閱 [環境變數](/help/environment) 以了解優先順序及完整詳情。

## 疑難排解：找不到 `openclaw`

<Accordion title="PATH 診斷與修復">
  快速診斷：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

如果 `$(npm prefix -g)/bin` (macOS/Linux) 或 `$(npm prefix -g)` (Windows) **不在** 您的 `$PATH` 中，您的 shell 就找不到全域 npm 二進位檔案（包括 `openclaw`）。

修復 — 將其新增至您的 shell 啟動檔案（`~/.zshrc` 或 `~/.bashrc`）：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

在 Windows 上，將 `npm prefix -g` 的輸出新增至您的 PATH。

然後開啟新的終端機（或在 zsh 中執行 `rehash` / 在 bash 中執行 `hash -r`）。
</Accordion>

## 更新 / 卸載

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    保持 OpenClaw 為最新版本。
  </Card>
  <Card title="遷移" href="/install/migrating" icon="arrow-right">
    遷移至新機器。
  </Card>
  <Card title="卸載" href="/install/uninstall" icon="trash-2">
    完全移除 OpenClaw。
  </Card>
</CardGroup>
