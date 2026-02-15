```yaml
summary: "安裝程式腳本 (install.sh, install-cli.sh, install.ps1) 的運作方式、旗標及自動化"
read_when:
  - 您想了解 `openclaw.ai/install.sh`
  - 您想自動化安裝 (CI / 無頭模式)
  - 您想從 GitHub 儲存庫安裝
title: "安裝程式內部原理"
---

# 安裝程式內部原理

OpenClaw 提供三個安裝程式腳本，皆可從 `openclaw.ai` 取得。

| 腳本                              | 平台                 | 功能                                                                                          |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | 如果需要，安裝 Node，透過 npm (預設) 或 git 安裝 OpenClaw，並可執行新手導覽。              |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | 將 Node + OpenClaw 安裝到 local prefix (`~/.openclaw`)。無需 root 權限。                      |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 如果需要，安裝 Node，透過 npm (預設) 或 git 安裝 OpenClaw，並可執行新手導覽。              |

## 快速指令

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
如果安裝成功但在新終端機中找不到 `openclaw`，請參閱 [Node.js 疑難排解](/install/node#troubleshooting)。
</Note>

---

## install.sh

<Tip>
建議用於 macOS/Linux/WSL 上大多數的互動式安裝。
</Tip>

### 流程 (install.sh)

<Steps>
  <Step title="偵測作業系統">
    支援 macOS 和 Linux (包括 WSL)。如果偵測到 macOS，若 Homebrew 遺失則會安裝。
  </Step>
  <Step title="確保 Node.js 22+">
    檢查 Node 版本，如果需要則安裝 Node 22 (macOS 上使用 Homebrew，Linux apt/dnf/yum 上使用 NodeSource 設定腳本)。
  </Step>
  <Step title="確保 Git">
    如果 Git 遺失則安裝。
  </Step>
  <Step title="安裝 OpenClaw">
    - `npm` 方法 (預設)：全域 npm 安裝
    - `git` 方法：複製/更新儲存庫，使用 pnpm 安裝依賴項，建置，然後將包裝器安裝到 `~/.local/bin/openclaw`
  </Step>
  <Step title="安裝後任務">
    - 升級和 git 安裝時執行 `openclaw doctor --non-interactive` (盡力而為)
    - 在適當時嘗試新手導覽 (TTY 可用、新手導覽未停用，且引導/設定檢查通過)
    - 預設 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 來源儲存庫偵測

如果在 OpenClaw 儲存庫 (`package.json` + `pnpm-workspace.yaml`) 內部執行，腳本會提供：

- 使用儲存庫 (`git`)，或
- 使用全域安裝 (`npm`)

如果沒有 TTY 可用且未設定安裝方法，則預設為 `npm` 並發出警告。

如果選擇的方法無效或 `--install-method` 值無效，腳本將以代碼 `2` 結束。

### 範例 (install.sh)

<Tabs>
  <Tab title="預設">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="跳過新手導覽">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git 安裝">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="模擬執行">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="旗標參考">

| Flag                            | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `--install-method npm\|git`     | 選擇安裝方法 (預設: `npm`)。別名: `--method`               |
| `--npm`                         | npm 方法的捷徑                                             |
| `--git`                         | git 方法的捷徑。別名: `--github`                          |
| `--version <version\|dist-tag>` | npm 版本或 dist-tag (預設: `latest`)                       |
| `--beta`                        | 如果有 beta dist-tag 則使用，否則退回 `latest`             |
| `--git-dir <path>`              | 儲存庫目錄 (預設: `~/openclaw`)。別名: `--dir`             |
| `--no-git-update`               | 略過現有儲存庫的 `git pull`                                |
| `--no-prompt`                   | 停用提示                                                   |
| `--no-onboard`                  | 略過新手導覽                                               |
| `--onboard`                     | 啟用新手導覽                                               |
| `--dry-run`                     | 列印動作但不實際套用更改                                   |
| `--verbose`                     | 啟用偵錯輸出 (`set -x`, npm notice-level logs)             |
| `--help`                        | 顯示用法 (`-h`)                                            |

  </Accordion>

  <Accordion title="環境變數參考">

| Variable                                    | Description                                   |
| ------------------------------------------- | --------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | 安裝方法                                      |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm 版本或 dist-tag                           |
| `OPENCLAW_BETA=0\|1`                        | 如果可用則使用 beta                           |
| `OPENCLAW_GIT_DIR=<path>`                   | 儲存庫目錄                                    |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | 切換 git 更新                                 |
| `OPENCLAW_NO_PROMPT=1`                      | 停用提示                                      |
| `OPENCLAW_NO_ONBOARD=1`                     | 略過新手導覽                                  |
| `OPENCLAW_DRY_RUN=1`                        | 模擬執行模式                                  |
| `OPENCLAW_VERBOSE=1`                        | 偵錯模式                                      |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 日誌級別                                  |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | 控制 sharp/libvips 行為 (預設: `1`)         |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
專為需要將所有內容安裝在 local prefix (預設為 `~/.openclaw`) 且無系統 Node 依賴的環境而設計。
</Info>

### 流程 (install-cli.sh)

<Steps>
  <Step title="安裝 local Node 執行環境">
    下載 Node tarball (預設 `22.22.0`) 到 `<prefix>/tools/node-v<version>` 並驗證 SHA-256。
  </Step>
  <Step title="確保 Git">
    如果 Git 遺失，嘗試透過 Linux 上的 apt/dnf/yum 或 macOS 上的 Homebrew 安裝。
  </Step>
  <Step title="在 prefix 下安裝 OpenClaw">
    使用 `npm --prefix <prefix>` 安裝，然後將包裝器寫入 `<prefix>/bin/openclaw`。
  </Step>
</Steps>

### 範例 (install-cli.sh)

<Tabs>
  <Tab title="預設">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="自訂 prefix + 版本">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="自動化 JSON 輸出">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="執行新手導覽">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="旗標參考">

| Flag                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--prefix <path>`      | 安裝 prefix (預設: `~/.openclaw`)                                                 |
| `--version <ver>`      | OpenClaw 版本或 dist-tag (預設: `latest`)                                       |
| `--node-version <ver>` | Node 版本 (預設: `22.22.0`)                                                       |
| `--json`               | 發出 NDJSON 事件                                                                |
| `--onboard`            | 安裝後執行 `openclaw onboard`                                                     |
| `--no-onboard`         | 略過新手導覽 (預設)                                                             |
| `--set-npm-prefix`     | 在 Linux 上，如果目前的 prefix 不可寫入，則強制 npm prefix 為 `~/.npm-global`   |
| `--help`               | 顯示用法 (`-h`)                                                                 |

  </Accordion>

  <Accordion title="環境變數參考">

| Variable                                    | Description                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | 安裝 prefix                                                                       |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw 版本或 dist-tag                                                          |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node 版本                                                                         |
| `OPENCLAW_NO_ONBOARD=1`                     | 略過新手導覽                                                                      |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 日誌級別                                                                      |
| `OPENCLAW_GIT_DIR=<path>`                   | 舊版清理查詢路徑 (用於移除舊的 `Peekaboo` 子模組儲存庫時)                          |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | 控制 sharp/libvips 行為 (預設: `1`)                                             |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### 流程 (install.ps1)

<Steps>
  <Step title="確保 PowerShell + Windows 環境">
    需要 PowerShell 5+。
  </Step>
  <Step title="確保 Node.js 22+">
    如果遺失，嘗試透過 winget、然後 Chocolatey、然後 Scoop 安裝。
  </Step>
  <Step title="安裝 OpenClaw">
    - `npm` 方法 (預設)：使用選定的 `-Tag` 進行全域 npm 安裝
    - `git` 方法：複製/更新儲存庫，使用 pnpm 安裝/建置，然後將包裝器安裝到 `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="安裝後任務">
    如果可能，將所需的 bin 目錄加入使用者 PATH，然後在升級和 git 安裝時執行 `openclaw doctor --non-interactive` (盡力而為)。
  </Step>
</Steps>

### 範例 (install.ps1)

<Tabs>
  <Tab title="預設">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git 安裝">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="自訂 git 目錄">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="模擬執行">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="偵錯追蹤">
    ```powershell
    # install.ps1 目前尚未公開 -Verbose 開關。
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="旗標參考">

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `-InstallMethod npm\|git` | 安裝方法 (預設: `npm`)                                   |
| `-Tag <tag>`              | npm dist-tag (預設: `latest`)                            |
| `-GitDir <path>`          | 儲存庫目錄 (預設: `%USERPROFILE%\openclaw`)              |
| `-NoOnboard`              | 略過新手導覽                                           |
| `-NoGitUpdate`            | 略過 `git pull`                                        |
| `-DryRun`                 | 僅列印動作                                             |

  </Accordion>

  <Accordion title="環境變數參考">

| Variable                           | Description        |
| ---------------------------------- | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | 安裝方法           |
| `OPENCLAW_GIT_DIR=<path>`          | 儲存庫目錄         |
| `OPENCLAW_NO_ONBOARD=1`            | 略過新手導覽       |
| `OPENCLAW_GIT_UPDATE=0`            | 停用 git pull      |
| `OPENCLAW_DRY_RUN=1`               | 模擬執行模式       |

  </Accordion>
</AccordionGroup>

<Note>
如果使用 `-InstallMethod git` 且 Git 遺失，腳本將結束並列印 Git for Windows 連結。
</Note>

---

## CI 和自動化

使用非互動式旗標/環境變數以進行可預測的執行。

<Tabs>
  <Tab title="install.sh (非互動式 npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (非互動式 git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (略過新手導覽)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## 疑難排解

<AccordionGroup>
  <Accordion title="為何需要 Git？">
    Git 對於 `git` 安裝方法是必需的。對於 `npm` 安裝，仍然會檢查/安裝 Git，以避免當依賴項使用 git URL 時出現 `spawn git ENOENT` 失敗。
  </Accordion>

  <Accordion title="為何 npm 在 Linux 上會遇到 EACCES 錯誤？">
    某些 Linux 設定將 npm 全域 prefix 指向 root 擁有的路徑。`install.sh` 可以將 prefix 切換到 `~/.npm-global`，並將 PATH 匯出附加到 shell rc 檔案 (當這些檔案存在時)。
  </Accordion>

  <Accordion title="sharp/libvips 問題">
    腳本預設 `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 以避免 sharp 針對系統 libvips 建置。要覆寫：

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    安裝 Git for Windows，重新開啟 PowerShell，然後重新執行安裝程式。
  </Accordion>

  <Accordion title='Windows: "openclaw 未被識別"'>
    執行 `npm config get prefix`，附加 `\bin`，將該目錄新增到使用者 PATH，然後重新開啟 PowerShell。
  </Accordion>

  <Accordion title="Windows: 如何取得詳細的安裝程式輸出">
    `install.ps1` 目前尚未公開 `-Verbose` 開關。
    使用 PowerShell 追蹤進行腳本級別的診斷：

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="安裝後找不到 openclaw">
    通常是 PATH 問題。請參閱 [Node.js 疑難排解](/install/node#troubleshooting)。
  </Accordion>
</AccordionGroup>
```
