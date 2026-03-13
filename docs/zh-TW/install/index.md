---
summary: "Install OpenClaw — installer script, npm/pnpm, from source, Docker, and more"
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a cloud platform
  - "You need to update, migrate, or uninstall"
title: Install
---

# 安裝

已經完成[快速開始](/start/getting-started)了嗎？你已經準備好了 — 本頁面提供替代安裝方法、平台特定指示及維護說明。

## 系統需求

- **[Node 24（推薦）](/install/node)**（Node 22 LTS，目前為 `22.16+`，仍支援以維持相容性；[安裝腳本](#install-methods)會在缺少時安裝 Node 24）
- macOS、Linux 或 Windows
- `pnpm` 僅在從原始碼編譯時需要

<Note>
在 Windows 上，我們強烈建議在 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 環境下執行 OpenClaw。
</Note>

## 安裝方法

<Tip>
**安裝腳本** 是安裝 OpenClaw 的推薦方式。它能一次完成 Node 偵測、安裝及新手引導。
</Tip>

<Warning>
對於 VPS/雲端主機，盡量避免使用第三方「一鍵安裝」市集映像。建議使用乾淨的基礎作業系統映像（例如 Ubuntu LTS），然後用安裝腳本自行安裝 OpenClaw。
</Warning>

<AccordionGroup>
  <Accordion title="安裝腳本" icon="rocket" defaultOpen>
    下載 CLI，透過 npm 全域安裝，並啟動新手引導。

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

就這樣 — 腳本會自動處理 Node 偵測、安裝及新手引導。

若想跳過新手引導，只安裝執行檔：

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

所有參數、環境變數及 CI/自動化選項，請參考[安裝腳本內部說明](/install/installer)。

</Accordion>

<Accordion title="npm / pnpm" icon="package">
    如果你已經自行管理 Node，我們建議使用 Node 24。OpenClaw 仍支援 Node 22 LTS，目前為 `22.16+`，以維持相容性：

<Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

<Accordion title="sharp 編譯錯誤？">
          如果你全域安裝了 libvips（macOS 常透過 Homebrew 安裝），且 `sharp` 失敗，請強制使用預編譯二進位檔：

````bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

如果你看到 `sharp: Please add node-gyp to your dependencies`，請安裝編譯工具（macOS：Xcode CLT + `npm install -g node-gyp`）或使用上述環境變數。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

<Note>
        pnpm 需要明確允許帶有編譯腳本的套件。首次安裝出現「Ignored build scripts」警告後，請執行 `pnpm approve-builds -g` 並選擇列出的套件。
        </Note>
      </Tab>
    </Tabs>

</Accordion>

<Accordion title="從原始碼安裝" icon="github">
    適用於貢獻者或想從本地檢出執行的人。

<Steps>
      <Step title="Clone 並編譯">
        Clone [OpenClaw 倉庫](https://github.com/openclaw/openclaw) 並編譯：

```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="連結 CLI">
        讓 `openclaw` 指令可全域使用：

```bash
        pnpm link --global
        ```

或者，跳過連結，直接在倉庫內透過 `pnpm openclaw ...` 執行指令。
      </Step>
      <Step title="執行初始設定">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

如需更深入的開發流程，請參考 [設定](/start/setup)。

</Accordion>
</AccordionGroup>

## 其他安裝方式

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    容器化或無頭部署。
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    無根容器：先執行 `setup-podman.sh`，然後執行啟動腳本。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    透過 Nix 進行宣告式安裝。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化群組佈署。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    透過 Bun 執行環境僅限 CLI 使用。
  </Card>
</CardGroup>

## 安裝後

確認一切運作正常：

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
````

如果需要自訂執行時路徑，請使用：

- `OPENCLAW_HOME` 用於基於家目錄的內部路徑
- `OPENCLAW_STATE_DIR` 用於可變狀態位置
- `OPENCLAW_CONFIG_PATH` 用於設定檔位置

詳情及優先順序請參考[環境變數](/help/environment)。

## 疑難排解：找不到 `openclaw`

<Accordion title="PATH 診斷與修復">
  快速診斷：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

如果 `$(npm prefix -g)/bin`（macOS/Linux）或 `$(npm prefix -g)`（Windows）**不在**你的 `$PATH` 中，則你的 shell 找不到全域 npm 執行檔（包含 `openclaw`）。

修復方法 — 將它加入你的 shell 啟動檔（`~/.zshrc` 或 `~/.bashrc`）：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

在 Windows 上，將 `npm prefix -g` 的輸出加入你的 PATH。

然後開啟新的終端機（或在 zsh 使用 `rehash` / 在 bash 使用 `hash -r`）。
</Accordion>

## 更新 / 移除

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    保持 OpenClaw 最新版本。
  </Card>
  <Card title="遷移" href="/install/migrating" icon="arrow-right">
    移轉到新機器。
  </Card>
  <Card title="移除" href="/install/uninstall" icon="trash-2">
    完全移除 OpenClaw。
  </Card>
</CardGroup>
