---
title: Node.js
summary: >-
  Install and configure Node.js for OpenClaw — version requirements, install
  options, and PATH troubleshooting
read_when:
  - You need to install Node.js before installing OpenClaw
  - You installed OpenClaw but `openclaw` is command not found
  - npm install -g fails with permissions or PATH issues
---

# Node.js

OpenClaw 需要 **Node 22.16 或更新版本**。**Node 24 是預設且推薦的執行環境**，適用於安裝、CI 及發行工作流程。Node 22 仍透過活躍的 LTS 版本線獲得支援。[安裝腳本](/install#install-methods)會自動偵測並安裝 Node — 本頁面適用於你想自行設定 Node 並確保所有設定（版本、PATH、全域安裝）正確無誤的情況。

## 檢查你的版本

```bash
node -v
```

如果輸出為 `v24.x.x` 或更高版本，表示你使用的是推薦的預設版本。如果輸出為 `v22.16.x` 或更高版本，表示你使用的是支援中的 Node 22 LTS 版本，但我們仍建議在方便時升級到 Node 24。如果尚未安裝 Node 或版本過舊，請從下方選擇安裝方式。

## 安裝 Node

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推薦）：

````bash
    brew install node
    ```

或從 [nodejs.org](https://nodejs.org/) 下載 macOS 安裝程式。

</Tab>
  <Tab title="Linux">
    **Ubuntu / Debian：**

```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

**Fedora / RHEL：**

```bash
    sudo dnf install nodejs
    ```

或使用版本管理工具（見下方說明）。

</Tab>
  <Tab title="Windows">
    **winget**（推薦）：

```powershell
    winget install OpenJS.NodeJS.LTS
    ```

**Chocolatey：**

```powershell
    choco install nodejs-lts
    ```

或從 [nodejs.org](https://nodejs.org/) 下載 Windows 安裝程式。

</Tab>
</Tabs>

<Accordion title="使用版本管理工具（nvm、fnm、mise、asdf）">
  版本管理工具讓你輕鬆切換 Node 版本。常見選項：

- [**fnm**](https://github.com/Schniz/fnm) — 快速、跨平台
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux 上廣泛使用
- [**mise**](https://mise.jdx.dev/) — 多語言管理（Node、Python、Ruby 等）

fnm 範例：

```bash
fnm install 24
fnm use 24
````

<Warning>
  請確保你的版本管理工具已在 shell 啟動檔 (`~/.zshrc` 或 `~/.bashrc`) 中初始化。如果沒有，`openclaw` 可能在新的終端機工作階段找不到，因為 PATH 不會包含 Node 的 bin 目錄。
  </Warning>
</Accordion>

## 疑難排解

### `openclaw: command not found`

這幾乎總是表示 npm 的全域 bin 目錄不在你的 PATH 中。

<Steps>
  <Step title="找出你的全域 npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="檢查它是否在你的 PATH 中">
    ```bash
    echo "$PATH"
    ```

在輸出中尋找 `<npm-prefix>/bin`（macOS/Linux）或 `<npm-prefix>`（Windows）。

</Step>
  <Step title="將它加入你的 shell 啟動檔">
    <Tabs>
      <Tab title="macOS / Linux">
        加入到 `~/.zshrc` 或 `~/.bashrc`：

````bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

然後開啟一個新的終端機（或在 zsh 執行 `rehash` / 在 bash 執行 `hash -r`）。
      </Tab>
      <Tab title="Windows">
        將 `npm prefix -g` 的輸出加入系統 PATH，路徑為 設定 → 系統 → 環境變數。
      </Tab>
    </Tabs>

</Step>
</Steps>

### `npm install -g` 上的權限錯誤（Linux）

如果你看到 `EACCES` 錯誤，請將 npm 的全域前綴切換到使用者可寫入的目錄：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
````

將 `export PATH=...` 這行加入你的 `~/.bashrc` 或 `~/.zshrc`，以永久生效。
