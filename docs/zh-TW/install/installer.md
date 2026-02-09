---
summary: "安裝程式腳本（install.sh、install-cli.sh、install.ps1）的運作方式、旗標與自動化"
read_when:
  - 你想了解 `openclaw.ai/install.sh`
  - 你想自動化安裝（CI／無互動）
  - 你想從 GitHub 檢出內容進行安裝
title: "安裝程式內部機制"
---

# 42. 安裝程式內部機制

OpenClaw 提供三個安裝程式腳本，皆由 `openclaw.ai` 提供。

| 43. 腳本      | 平台                  | What it does                                             |
| ---------------------------------- | ------------------- | -------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS／Linux／WSL     | 視需要安裝 Node，透過 npm（預設）或 git 安裝 OpenClaw，並可執行入門引導。         |
| [`install-cli.sh`](#install-clish) | macOS／Linux／WSL     | 將 Node 與 OpenClaw 安裝到本機前綴目錄（`~/.openclaw`）。 不需要 root 權限。 |
| [`install.ps1`](#installps1)       | Windows（PowerShell） | 視需要安裝 Node，透過 npm（預設）或 git 安裝 OpenClaw，並可執行入門引導。         |

## 快速指令

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
如果安裝成功，但在新終端機中找不到 `openclaw`，請參閱 [Node.js 疑難排解](/install/node#troubleshooting)。
</Note>

---

## install.sh

<Tip>
建議用於 macOS／Linux／WSL 上大多數互動式安裝。
</Tip>

### 流程（install.sh）

<Steps>
  <Step title="Detect OS">
    
    支援 macOS 與 Linux（包含 WSL）。若偵測到 macOS，且尚未安裝 Homebrew，則會進行安裝。
   46. 若偵測到 macOS，且尚未安裝，將會安裝 Homebrew。
  </Step>
  <Step title="Ensure Node.js 22+">
    檢查 Node 版本，必要時安裝 Node 22（macOS 使用 Homebrew；Linux 使用 NodeSource 設定腳本，適用於 apt／dnf／yum）。
  </Step>
  <Step title="Ensure Git">
    若未安裝 Git，則進行安裝。
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 方法（預設）：全域 npm 安裝
    - `git` 方法：複製／更新儲存庫，使用 pnpm 安裝相依套件並建置，接著在 `~/.local/bin/openclaw` 安裝包裝程式
  </Step>
  <Step title="Post-install tasks">
    - 在升級與 git 安裝時執行 `openclaw doctor --non-interactive`（盡力而為）
    - 在適當情況下嘗試入門引導（可用 TTY、未停用入門引導，且通過 bootstrap／設定檢查）
    - 預設 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 原始碼檢出偵測

若在 OpenClaw 檢出內容內執行（`package.json` + `pnpm-workspace.yaml`），腳本會提供：

- 48. 使用檢出（`git`），或
- 使用全域安裝（`npm`）

如果沒有可用的 TTY，且未設定安裝方法，則預設為 `npm` 並顯示警告。

若選擇的安裝方法無效或 `--install-method` 值無效，腳本會以代碼 `2` 結束。

### 範例（install.sh）

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| 旗標                                | Description                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | 選擇安裝方法（預設：`npm`）。別名：`--method` 49. 別名：`--method`                                                              |
| `--npm`                           | npm 方法的捷徑                                                                                                                     |
| `--git`                           | git 方法的捷徑。別名：`--github` 別名：`--github`                                                                                         |
| `--version <version\\|dist-tag>` | npm 版本或 dist-tag（預設：`latest`）                                                                                                 |
| `--beta`                          | 若可用則使用 beta dist-tag，否則回退至 `latest`                                                                                           |
| `--git-dir <path>`                | Checkout directory (default: `~/openclaw`). Alias: `--dir` |
| `--no-git-update`                 | Skip `git pull` for existing checkout                                                                                         |
| `--no-prompt`                     | 停用提示                                                                                                                          |
| `--no-onboard`                    | Skip onboarding                                                                                                               |
| `--onboard`                       | Enable onboarding                                                                                                             |
| `--dry-run`                       | 僅列印動作，不套用變更                                                                                                                   |
| `--verbose`                       | 啟用除錯輸出（`set -x`、npm notice 級別日誌）                                                                                              |
| `--help`                          | 顯示使用說明（`-h`）                                                                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| 變數                                              | Description                 |
| ----------------------------------------------- | --------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | 安裝方法                        |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm 版本或 dist-tag            |
| `OPENCLAW_BETA=0\\|1`                          | 若可用則使用 beta                 |
| `OPENCLAW_GIT_DIR=<path>`                       | Checkout directory          |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | 切換 git 更新                   |
| `OPENCLAW_NO_PROMPT=1`                          | 停用提示                        |
| `OPENCLAW_NO_ONBOARD=1`                         | Skip onboarding             |
| `OPENCLAW_DRY_RUN=1`                            | Dry run 模式                  |
| `OPENCLAW_VERBOSE=1`                            | 除錯模式                        |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm 日誌層級                    |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | 控制 sharp/libvips 行為（預設：`1`） |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Designed for environments where you want everything under a local prefix (default `~/.openclaw`) and no system Node dependency.
</Info>

### 流程（install-cli.sh）

<Steps>
  <Step title="Install local Node runtime">
    下載 Node tarball（預設 `22.22.0`）至 `<prefix>/tools/node-v<version>`，並驗證 SHA-256。
  </Step>
  <Step title="Ensure Git">
    若未安裝 Git，會嘗試在 Linux 上透過 apt／dnf／yum，或在 macOS 上透過 Homebrew 安裝。
  </Step>
  <Step title="Install OpenClaw under prefix">
    使用 npm 以 `--prefix <prefix>`, then writes wrapper to `<prefix>/bin/openclaw`。
  </Step>
</Steps>

### 範例（install-cli.sh）

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| 旗標                     | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `--prefix <path>`      | 安裝前綴路徑（預設：`~/.openclaw`）                           |
| `--version <ver>`      | OpenClaw 版本或 dist-tag（預設：`latest`）                 |
| `--node-version <ver>` | Node 版本（預設：`22.22.0`）                              |
| `--json`               | 輸出 NDJSON 事件                                       |
| `--onboard`            | 安裝後執行 `openclaw onboard`                           |
| `--no-onboard`         | 跳過入門引導（預設）                                         |
| `--set-npm-prefix`     | 在 Linux 上，若目前前綴路徑不可寫入，強制將 npm 前綴設為 `~/.npm-global` |
| `--help`               | 顯示使用說明（`-h`）                                       |

  </Accordion>

  <Accordion title="Environment variables reference">

| 變數                                              | Description                           |
| ----------------------------------------------- | ------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | 安裝前綴路徑                                |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw 版本或 dist-tag                 |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node 版本                               |
| `OPENCLAW_NO_ONBOARD=1`                         | Skip onboarding                       |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm 日誌層級                              |
| `OPENCLAW_GIT_DIR=<path>`                       | 舊版清理查找路徑（在移除舊的 `Peekaboo` 子模組檢出內容時使用） |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | 控制 sharp/libvips 行為（預設：`1`）           |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### 流程（install.ps1）

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    需要 PowerShell 5+。
  </Step>
  <Step title="Ensure Node.js 22+">
    若缺少，會依序嘗試透過 winget、Chocolatey、Scoop 安裝。
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 方法（預設）：使用選定的 `-Tag` 進行全域 npm 安裝
    - `git` 方法：複製／更新儲存庫，使用 pnpm 安裝／建置，並在 `%USERPROFILE%\.local\bin\openclaw.cmd` 安裝包裝程式
  </Step>
  <Step title="Post-install tasks">
    在可行情況下將所需的 bin 目錄加入使用者 PATH，接著在升級與 git 安裝時執行 `openclaw doctor --non-interactive`（盡力而為）。
  </Step>
</Steps>

### 範例（install.ps1）

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| 旗標                          | Description                        |
| --------------------------- | ---------------------------------- |
| `-InstallMethod npm\\|git` | 安裝方法（預設：`npm`）                     |
| `-Tag <tag>`                | npm dist-tag（預設：`latest`）          |
| `-GitDir <path>`            | 檢出目錄（預設：`%USERPROFILE%\openclaw`） |
| `-NoOnboard`                | Skip onboarding                    |
| `-NoGitUpdate`              | 跳過 `git pull`                      |
| `-DryRun`                   | 僅列印動作                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| 變數                                   | Description        |
| ------------------------------------ | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | 安裝方法               |
| `OPENCLAW_GIT_DIR=<path>`            | Checkout directory |
| `OPENCLAW_NO_ONBOARD=1`              | Skip onboarding    |
| `OPENCLAW_GIT_UPDATE=0`              | 停用 git pull        |
| `OPENCLAW_DRY_RUN=1`                 | Dry run 模式         |

  </Accordion>
</AccordionGroup>

<Note>
若使用 `-InstallMethod git` 且缺少 Git，腳本會結束並輸出 Git for Windows 連結。
</Note>

---

## CI 與自動化

Use non-interactive flags/env vars for predictable runs.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
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
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is required for `git` install method. 
    Git 是 `git` 安裝方法所必需。對於 `npm` 安裝，仍會檢查／安裝 Git，以避免在相依套件使用 git URL 時發生 `spawn git ENOENT` 失敗。
  
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    
    某些 Linux 設定會將 npm 全域前綴指向 root 擁有的路徑。`install.sh` 可將前綴切換為 `~/.npm-global`，並在 shell rc 檔案存在時附加 PATH 匯出設定。
   `install.sh` can switch prefix to `~/.npm-global` and append PATH exports to shell rc files (when those files exist).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    The scripts default `SHARP_IGNORE_GLOBAL_LIBVIPS=1` to avoid sharp building against system libvips. To override:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    安裝 Git for Windows，重新開啟 PowerShell，然後重新執行安裝程式。
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    執行 `npm config get prefix`，附加 `\bin`，將該目錄加入使用者 PATH，然後重新開啟 PowerShell。
  </Accordion>

  <Accordion title="openclaw not found after install">
    Usually a PATH issue. 
    通常是 PATH 問題。請參閱 [Node.js 疑難排解](/install/node#troubleshooting)。
  
  </Accordion>
</AccordionGroup>
