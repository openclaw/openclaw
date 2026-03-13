---
summary: >-
  How the installer scripts work (install.sh, install-cli.sh, install.ps1),
  flags, and automation
read_when:
  - You want to understand `openclaw.ai/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
title: Installer Internals
---

# 安裝程式內部結構

OpenClaw 提供三個安裝腳本，從 `openclaw.ai` 取得。

| 腳本                               | 平台                 | 功能說明                                                                      |
| ---------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | 如有需要會安裝 Node，透過 npm（預設）或 git 安裝 OpenClaw，並可執行新手引導。 |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | 安裝 Node + OpenClaw 至本地前綴目錄 (`~/.openclaw`)，不需 root 權限。         |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 如有需要會安裝 Node，透過 npm（預設）或 git 安裝 OpenClaw，並可執行新手引導。 |

## 快速指令

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

````bash
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
如果安裝成功但在新終端機找不到 `openclaw`，請參考 [Node.js 疑難排解](/install/node#troubleshooting)。
</Note>

---

## install.sh

<Tip>
建議用於 macOS/Linux/WSL 上大多數互動式安裝。
</Tip>

### 流程 (install.sh)

<Steps>
  <Step title="偵測作業系統">
    支援 macOS 與 Linux（包含 WSL）。若偵測到 macOS，且缺少 Homebrew，則安裝 Homebrew。
  </Step>
  <Step title="預設確保 Node.js 24">
    檢查 Node 版本，必要時安裝 Node 24（macOS 使用 Homebrew，Linux 使用 NodeSource 設定腳本 apt/dnf/yum）。OpenClaw 仍支援 Node 22 LTS，目前為 `22.16+`，以維持相容性。
  </Step>
  <Step title="確保 Git">
    若缺少 Git，則安裝 Git。
  </Step>
  <Step title="安裝 OpenClaw">
    - `npm` 方法（預設）：全域 npm 安裝
    - `git` 方法：複製/更新原始碼庫，使用 pnpm 安裝相依套件，編譯，然後在 `~/.local/bin/openclaw` 安裝包裝器
  </Step>
  <Step title="安裝後任務">
    - 在升級與 git 安裝時執行 `openclaw doctor --non-interactive`（盡力而為）
    - 適當時嘗試啟動導引（有 TTY、未禁用導引，且通過 bootstrap/config 檢查）
    - 預設 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 原始碼庫檢出偵測

若在 OpenClaw 原始碼庫檢出目錄內執行 (`package.json` + `pnpm-workspace.yaml`)，腳本會提供：

- 使用檢出目錄 (`git`), 或
- 使用全域安裝 (`npm`)

若無 TTY 且未設定安裝方法，預設為 `npm` 並發出警告。

腳本在方法選擇錯誤或 `--install-method` 值無效時，以程式碼 `2` 結束。

### 範例 (install.sh)

<Tabs>
  <Tab title="預設">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="跳過導引">
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
  <Accordion title="參數旗標說明">

| 旗標                            | 說明                                                |
| ------------------------------- | ---------------------------------------------------- |
| `--install-method npm\|git`     | 選擇安裝方法（預設：`npm`）。別名：`--method`  |
| `--npm`                         | npm 方法捷徑                                        |
| `--git`                         | git 方法捷徑。別名：`--github`                       |
| `--version <version\|dist-tag>` | npm 版本或發行標籤（預設：`latest`）                |
| `--beta`                        | 若有 beta 發行標籤則使用，否則回退至 `latest`      |
| `--git-dir <path>`              | 檢出目錄（預設：`~/openclaw`）。別名：`--dir`     |
| `--no-git-update`               | 已有檢出目錄時跳過 `git pull`                      |
| `--no-prompt`                   | 禁用提示                                              |
| `--no-onboard`                  | 跳過導引                                              |
| `--onboard`                     | 啟用導引                                              |
| `--dry-run`                     | 僅列印動作，不套用變更                                |
| `--verbose`                     | 啟用除錯輸出（`set -x`，npm notice-level 日誌）  |
| `--help`                        | 顯示用法說明（`-h`）                          |

</Accordion>

<Accordion title="環境變數說明">

| 變數                                    | 說明                                   |
| ------------------------------------------- | --------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | 安裝方法                                |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm 版本或發行標籤                       |
| `OPENCLAW_BETA=0\|1`                        | 若有 beta 則使用                         |
| `OPENCLAW_GIT_DIR=<path>`                   | 檢出目錄                                |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | 切換 git 更新                            |
| `OPENCLAW_NO_PROMPT=1`                      | 禁用提示                               |
| `OPENCLAW_NO_ONBOARD=1`                     | 跳過導引                               |
| `OPENCLAW_DRY_RUN=1`                        | 模擬執行模式                            |
| `OPENCLAW_VERBOSE=1`                        | 除錯模式                               |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 日誌等級                             |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | 控制 sharp/libvips 行為（預設：`1`） |

</Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
設計用於希望所有內容都安裝在本地前綴目錄（預設為 `~/.openclaw`）且不依賴系統 Node 的環境。
</Info>

### 流程 (install-cli.sh)

<Steps>
  <Step title="安裝本地 Node 執行環境">
    下載固定版本的支援 Node 壓縮包（目前預設為 `22.22.0`）到 `<prefix>/tools/node-v<version>`，並驗證 SHA-256。
  </Step>
  <Step title="確保 Git 已安裝">
    若缺少 Git，嘗試在 Linux 上透過 apt/dnf/yum 安裝，或在 macOS 上使用 Homebrew 安裝。
  </Step>
  <Step title="在前綴目錄下安裝 OpenClaw">
    使用 `--prefix <prefix>` 透過 npm 安裝，然後將包裝器寫入 `<prefix>/bin/openclaw`。
  </Step>
</Steps>

### 範例 (install-cli.sh)

<Tabs>
  <Tab title="預設">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="自訂前綴目錄 + 版本">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="自動化 JSON 輸出">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="執行入門流程">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="參數旗標說明">

| 旗標                   | 說明                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `--prefix <path>`      | 安裝前綴目錄（預設：`~/.openclaw`）                                         |
| `--version <ver>`      | OpenClaw 版本或發行標籤（預設：`latest`）                              |
| `--node-version <ver>` | Node 版本（預設：`22.22.0`）                                             |
| `--json`               | 輸出 NDJSON 事件                                                         |
| `--onboard`            | 安裝後執行 `openclaw onboard`                                                    |
| `--no-onboard`         | 跳過入門流程（預設）                                                      |
| `--set-npm-prefix`     | 在 Linux 上，若目前前綴目錄不可寫，強制將 npm 前綴設為 `~/.npm-global`       |
| `--help`               | 顯示使用說明（`-h`）                                              |

</Accordion>

<Accordion title="環境變數說明">

| 變數                                    | 說明                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | 安裝前綴目錄                                                              |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw 版本或發行標籤                                                  |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node 版本                                                                |
| `OPENCLAW_NO_ONBOARD=1`                     | 跳過入門流程                                                             |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 日誌等級                                                             |
| `OPENCLAW_GIT_DIR=<path>`                   | 舊版清理查找路徑（用於移除舊的 `Peekaboo` 子模組檢出）                 |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | 控制 sharp/libvips 行為（預設：`1`）                             |

</Accordion>
</AccordionGroup>

---

## install.ps1

### 流程 (install.ps1)

<Steps>
  <Step title="確保 PowerShell + Windows 環境">
    需要 PowerShell 5 以上版本。
  </Step>
  <Step title="預設確保 Node.js 24">
    若缺少，會依序嘗試透過 winget、Chocolatey、Scoop 安裝。Node 22 LTS，目前 `22.16+`，仍維持相容性支援。
  </Step>
  <Step title="安裝 OpenClaw">
    - `npm` 方式（預設）：使用選定的 `-Tag` 進行全域 npm 安裝
    - `git` 方式：clone/更新 repo，使用 pnpm 安裝/建置，並在 `%USERPROFILE%\.local\bin\openclaw.cmd` 安裝包裝器
  </Step>
  <Step title="安裝後任務">
    盡可能將所需的 bin 目錄加入使用者 PATH，然後在升級及 git 安裝時執行 `openclaw doctor --non-interactive`（盡力而為）。
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
  <Tab title="除錯追蹤">
    ```powershell
    # install.ps1 has no dedicated -Verbose flag yet.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="旗標參考">

| 旗標                      | 說明                                            |
| ------------------------- | ------------------------------------------------------ |
| `-InstallMethod npm\|git` | 安裝方式（預設：`npm`）                        |
| `-Tag <tag>`              | npm 發行標籤（預設：`latest`）                       |
| `-GitDir <path>`          | 取出目錄（預設：`%USERPROFILE%\openclaw`） |
| `-NoOnboard`              | 跳過新手導覽                                        |
| `-NoGitUpdate`            | 跳過 `git pull`                                        |
| `-DryRun`                 | 僅列印動作                                     |

</Accordion>

<Accordion title="環境變數參考">

| 變數                           | 說明        |
| ---------------------------------- | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | 安裝方式     |
| `OPENCLAW_GIT_DIR=<path>`          | 取出目錄 |
| `OPENCLAW_NO_ONBOARD=1`            | 跳過新手導覽    |
| `OPENCLAW_GIT_UPDATE=0`            | 停用 git pull   |
| `OPENCLAW_DRY_RUN=1`               | 模擬執行模式       |

</Accordion>
</AccordionGroup>

<Note>
若使用 `-InstallMethod git` 且系統缺少 Git，腳本會退出並列印 Git for Windows 下載連結。
</Note>

---

## CI 與自動化

請使用非互動式旗標/環境變數以確保執行可預期。

<Tabs>
  <Tab title="install.sh（非互動式 npm）">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh（非互動式 git）">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh（JSON）">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1（跳過新手導覽）">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## 疑難排解

<AccordionGroup>
  <Accordion title="為什麼需要 Git？">
    Git 是 `git` 安裝方式所必需的。對於 `npm` 安裝，仍會檢查/安裝 Git，以避免當依賴使用 git URL 時發生 `spawn git ENOENT` 失敗。
  </Accordion>

<Accordion title="為什麼在 Linux 上 npm 會遇到 EACCES？">
    有些 Linux 設定會將 npm 全域前綴指向 root 擁有的路徑。`install.sh` 可以切換前綴到 `~/.npm-global`，並將 PATH 匯出附加到 shell 的 rc 檔案（當這些檔案存在時）。
  </Accordion>

<Accordion title="sharp/libvips 問題">
    腳本預設 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`，以避免 sharp 連結系統的 libvips。若要覆寫：

```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

</Accordion>

<Accordion title='Windows：「npm error spawn git / ENOENT」'>
    安裝 Windows 版 Git，重新開啟 PowerShell，重新執行安裝程式。
  </Accordion>

<Accordion title='Windows：「openclaw is not recognized」'>
    執行 `npm config get prefix` 並將該目錄加入使用者 PATH（Windows 上不需要 `\bin` 後綴），然後重新開啟 PowerShell。
  </Accordion>

<Accordion title="Windows：如何取得詳細的安裝程式輸出">
    `install.ps1` 目前不支援 `-Verbose` 參數。
    請使用 PowerShell 追蹤功能進行腳本層級診斷：

```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

</Accordion>

<Accordion title="安裝後找不到 openclaw">
    通常是 PATH 設定問題。請參考 [Node.js 疑難排解](/install/node#troubleshooting)。
  </Accordion>
</AccordionGroup>
````
