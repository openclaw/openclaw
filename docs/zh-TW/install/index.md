---
summary: "安裝 OpenClaw — 安裝程式腳本、npm/pnpm、從原始碼、Docker 等"
read_when:
  - 你需要「入門指南」快速開始以外的安裝方式
  - 你想要部署到雲端平台
  - 你需要更新、遷移或解除安裝
title: "安裝"
---

# 安裝

34. 已經完成 [Getting Started](/start/getting-started)？ 一切就緒 — 本頁面提供替代安裝方式、平台特定指引與維護資訊。

## 系統需求

- **[Node 22+](/install/node)**（若未安裝，[安裝程式腳本](#install-methods) 會自動安裝）
- macOS、Linux 或 Windows
- 36. 僅在從原始碼建置時才需要 `pnpm`

<Note>
在 Windows 上，我們強烈建議於 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 下執行 OpenClaw。
</Note>

## 安裝方式

<Tip>
**安裝程式腳本** 是安裝 OpenClaw 的建議方式。 38. 它可在單一步驟中處理 Node 偵測、安裝與導覽設定。
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    下載 CLI、透過 npm 全域安裝，並啟動入門引導精靈。

    ```
    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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
    
    就這樣 — 腳本會處理 Node 偵測、安裝與入門引導。
    
    若要略過入門引導、僅安裝二進位檔：
    
    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows（PowerShell）">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>
    
    所有旗標、環境變數與 CI／自動化選項，請參閱 [Installer internals](/install/installer)。
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    若你已具備 Node 22+，並偏好自行管理安裝：

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```
    
        <Accordion title="sharp 建置錯誤？">
          若你已全域安裝 libvips（在 macOS 上常見於 Homebrew），且 `sharp` 失敗，請強制使用預先建置的二進位檔：
    
          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```
    
          若看到 `sharp: Please add node-gyp to your dependencies`，請安裝建置工具（macOS：Xcode CLT + `npm install -g node-gyp`），或使用上述環境變數。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```
    
        <Note>
        pnpm 需要對含有建置腳本的套件給予明確核准。首次安裝出現「Ignored build scripts」警告後，請執行 `pnpm approve-builds -g`，並選取列出的套件。
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">39. 
        適用於貢獻者或任何想要從本機檢出執行的人。

    ```
    <Steps>
      <Step title="複製並建置">
        複製 [OpenClaw repo](https://github.com/openclaw/openclaw) 並建置：
    
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
    
        或者略過連結，直接在 repo 內透過 `pnpm openclaw ...` 執行指令。
      </Step>
      <Step title="執行入門引導">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>
    
    更深入的開發流程，請參閱 [Setup](/start/setup)。
    ```

  </Accordion>
</AccordionGroup>

## 其他安裝方式

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    容器化或無介面部署。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    透過 Nix 進行宣告式安裝。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化叢集佈署。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    透過 Bun 執行階段進行僅 CLI 的使用。
  </Card>
</CardGroup>

## 安裝後

驗證一切是否正常運作：

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## 疑難排解：找不到 `openclaw`

<Accordion title="PATH diagnosis and fix">
  快速診斷：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

若 `$(npm prefix -g)/bin`（macOS/Linux）或 `$(npm prefix -g)`（Windows）**未**出現在你的 `$PATH` 中，表示你的 shell 無法找到全域 npm 二進位檔（包含 `openclaw`）。

修正 — 將其加入你的 shell 啟動檔（`~/.zshrc` 或 `~/.bashrc`）：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

在 Windows 上，請將 `npm prefix -g` 的輸出加入 PATH。

接著開啟新的終端機（或在 zsh 中執行 `rehash`／在 bash 中執行 `hash -r`）。 </Accordion> </Accordion>

## 更新／解除安裝

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    讓 OpenClaw 保持最新。
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    移轉到新機器。
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    完整移除 OpenClaw。
  </Card>
</CardGroup>
