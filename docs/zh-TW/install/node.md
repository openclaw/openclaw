---
title: "Node.js"
summary: "為 OpenClaw 安裝及設定 Node.js — 版本要求、安裝選項和 PATH 疑難排解"
read_when:
  - "您需要在安裝 OpenClaw 之前安裝 Node.js"
  - "您已安裝 OpenClaw 但 `openclaw` 指令找不到"
  - "npm install -g 因權限或 PATH 問題而失敗"
---

# Node.js

OpenClaw 需要 **Node 22 或更新版本**。[安裝指令稿](/install#install-methods)會自動偵測並安裝 Node — 本頁說明如何自行設定 Node，並確保所有設定（版本、PATH、全域安裝）都正確。

## 檢查您的版本

```bash
node -v
```

如果顯示 `v22.x.x` 或更高版本，表示一切正常。如果 Node 尚未安裝或版本過舊，請選擇以下其中一種安裝方法。

## 安裝 Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (推薦)：

    ```bash
    brew install node
    ```

    或從 [nodejs.org](https://nodejs.org/) 下載 macOS 安裝程式。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    或使用版本管理器 (請參閱下方)。

  </Tab>
  <Tab title="Windows">
    **winget** (推薦)：

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    或從 [nodejs.org](https://nodejs.org/) 下載 Windows 安裝程式。

  </Tab>
</Tabs>

<Accordion title="使用版本管理器 (nvm, fnm, mise, asdf)">
  版本管理器可讓您輕鬆切換 Node 版本。熱門選項：

- [**fnm**](https://github.com/Schniz/fnm) — 快速、跨平台
- [**nvm**](https://github.com/nvm-sh/nvm) — 廣泛用於 macOS/Linux
- [**mise**](https://mise.jdx.dev/) — 多語言 (Node、Python、Ruby 等)

使用 fnm 的範例：

```bash
fnm install 22
fnm use 22
```

  <Warning>
  請確保您的版本管理器已在您的 Shell 啟動檔案 (`~/.zshrc` 或 `~/.bashrc`) 中初始化。如果沒有，在新終端機工作階段中可能找不到 `openclaw`，因為 PATH 將不包含 Node 的 bin 目錄。
  </Warning>
</Accordion>

## 疑難排解

### `openclaw: command not found`

這幾乎總是表示 npm 的全域 bin 目錄不在您的 PATH 中。

<Steps>
  <Step title="找到您的全域 npm 前綴">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="檢查它是否在您的 PATH 中">
    ```bash
    echo "$PATH"
    ```

    在輸出中尋找 `<npm-prefix>/bin` (macOS/Linux) 或 `<npm-prefix>` (Windows)。

  </Step>
  <Step title="將它新增到您的 Shell 啟動檔案">
    <Tabs>
      <Tab title="macOS / Linux">
        新增至 `~/.zshrc` 或 `~/.bashrc`：

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        然後開啟一個新的終端機 (或在 zsh 中執行 `rehash` / 在 bash 中執行 `hash -r`)。
      </Tab>
      <Tab title="Windows">
        透過「設定」→「系統」→「環境變數」將 `npm prefix -g` 的輸出新增至您的系統 PATH。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` 上的權限錯誤 (Linux)

如果看到 `EACCES` 錯誤，請將 npm 的全域前綴切換到使用者可寫入的目錄：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

將 `export PATH=...` 行新增至您的 `~/.bashrc` 或 `~/.zshrc` 以使其永久生效。
