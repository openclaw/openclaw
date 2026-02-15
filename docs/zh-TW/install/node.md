---
title: "Node.js"
summary: "為 OpenClaw 安裝並設定 Node.js — 版本需求、安裝選項以及 PATH 疑難排解"
read_when:
  - "在安裝 OpenClaw 之前需要先安裝 Node.js"
  - "您已安裝 OpenClaw，但出現 `openclaw` 指令找不到 (command not found)"
  - "npm install -g 因權限或 PATH 問題而失敗"
---

# Node.js

OpenClaw 需要 **Node 22 或更新版本**。[安裝指令碼](/install#install-methods)會自動偵測並安裝 Node — 本頁面適用於您想手動設定 Node 並確保一切配置正確（版本、PATH、全域安裝）的情況。

## 檢查您的版本

```bash
node -v
```

如果顯示 `v22.x.x` 或更高版本，即可直接開始。如果尚未安裝 Node 或版本過舊，請選擇下方的安裝方式。

## 安裝 Node

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推薦）：

    ```bash
    brew install node
    ```

    或從 [nodejs.org](https://nodejs.org/) 下載 macOS 安裝程式。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian：**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL：**

    ```bash
    sudo dnf install nodejs
    ```

    或者使用版本管理器（見下文）。

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

<Accordion title="使用版本管理器 (nvm, fnm, mise, asdf)">
  版本管理器讓您能輕鬆地在不同 Node 版本之間切換。常用的選項包括：

- [**fnm**](https://github.com/Schniz/fnm) — 快速、跨平台
- [**nvm**](https://github.com/nvm-sh/nvm) — 在 macOS/Linux 上被廣泛使用
- [**mise**](https://mise.jdx.dev/) — 多語言支援 (Node, Python, Ruby 等)

使用 fnm 的範例：

```bash
fnm install 22
fnm use 22
```

  <Warning>
  請確保您的版本管理器已在 shell 啟動檔案（`~/.zshrc` 或 `~/.bashrc`）中完成初始化。否則，在新的終端機工作階段中可能找不到 `openclaw`，因為 PATH 將不包含 Node 的 bin 目錄。
  </Warning>
</Accordion>

## 疑難排解

### `openclaw: command not found`

這幾乎總是意味著 npm 的全域 bin 目錄不在您的 PATH 中。

<Steps>
  <Step title="找到您的全域 npm 前綴 (prefix)">
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
  <Step title="將其加入您的 shell 啟動檔案">
    <Tabs>
      <Tab title="macOS / Linux">
        新增至 `~/.zshrc` 或 `~/.bashrc`：

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        然後開啟新的終端機（或在 zsh 執行 `rehash` / 在 bash 執行 `hash -r`）。
      </Tab>
      <Tab title="Windows">
        透過 設定 → 系統 → 環境變數，將 `npm prefix -g` 的輸出結果加入您的系統 PATH。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### npm install -g 的權限錯誤 (Linux)

如果您看到 `EACCES` 錯誤，請將 npm 的全域前綴切換到使用者可寫入的目錄：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

將 `export PATH=...` 這一行加入您的 `~/.bashrc` 或 `~/.zshrc` 以使其永久生效。
