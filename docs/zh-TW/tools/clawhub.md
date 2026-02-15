---
summary: "ClawHub 指南：公開技能註冊中心 + CLI 工作流程"
read_when:
  - 向新使用者介紹 ClawHub
  - 安裝、搜尋或發布技能
  - 解釋 ClawHub CLI 旗標和同步行為
title: "ClawHub"
---

# ClawHub

ClawHub 是 **OpenClaw 的公開技能註冊中心**。這是一個免費的服務：所有技能都是公開、開放的，每個人都可以分享和重複使用。技能就是一個包含 `SKILL.md` 檔案（以及支援文字檔案）的資料夾。您可以在網頁應用程式中瀏覽技能，或使用 CLI 搜尋、安裝、更新和發布技能。

網站：[clawhub.ai](https://clawhub.ai)

## ClawHub 是什麼

- OpenClaw 技能的公開註冊中心。
- 技能套件和詮釋資料的版本化儲存。
- 用於搜尋、標籤和使用信號的裝置探索介面。

## 運作方式

1. 使用者發布技能套件（檔案 + 詮釋資料）。
2. ClawHub 儲存套件、解析詮釋資料並指定版本。
3. 註冊中心為搜尋和裝置探索建立技能索引。
4. 使用者在 OpenClaw 中瀏覽、下載和安裝技能。

## 您可以做什麼

- 發布新技能和現有技能的新版本。
- 依名稱、標籤或搜尋來裝置探索技能。
- 下載技能套件並檢查其檔案。
- 舉報具備惡意或不安全的技能。
- 如果您是管理員，可以隱藏、取消隱藏、刪除或封鎖。

## 適用對象（新手友善）

如果您想為 OpenClaw 智慧代理新增功能，ClawHub 是尋找和安裝技能最簡單的方式。您不需要知道後端如何運作。您可以：

- 以自然語言搜尋技能。
- 將技能安裝到您的工作區。
- 稍後使用一個命令更新技能。
- 透過發布您自己的技能來備份它們。

## 快速開始（非技術性）

1. 安裝 CLI（請參閱下一節）。
2. 搜尋您需要的東西：
   - `clawhub search "calendar"`
3. 安裝技能：
   - `clawhub install <skill-slug>`
4. 啟動新的 OpenClaw 工作階段，使其取得新技能。

## 安裝 CLI

擇一：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## 它如何融入 OpenClaw

預設情況下，CLI 會將技能安裝到您目前工作目錄下的 `./skills`。如果 OpenClaw 工作區已設定，`clawhub` 會回溯到該工作區，除非您覆寫 `--workdir`（或 `CLAWHUB_WORKDIR`）。OpenClaw 從 `<workspace>/skills` 載入工作區技能，並將在**下一個**工作階段中取得這些技能。如果您已經使用 `~/.openclaw/skills` 或捆綁的技能，工作區技能將優先。

有關技能如何載入、共享和管控的更多詳細資訊，請參閱
[技能](/tools/skills)。

## 技能系統概述

技能是版本化的檔案套件，它教導 OpenClaw 如何執行特定任務。每次發布都會建立一個新版本，註冊中心會保留版本的歷史記錄，以便使用者可以審核變更。

典型的技能包括：

- 帶有主要描述和用法的 `SKILL.md` 檔案。
- 選用的技能使用的設定檔、指令碼或支援檔案。
- 詮釋資料，例如標籤、摘要和安裝要求。

ClawHub 使用詮釋資料來推動裝置探索並安全地公開技能功能。
註冊中心還會追蹤使用信號（例如星標和下載次數）以改善排名和可見性。

## 服務提供什麼（功能）

- 技能及其 `SKILL.md` 內容的**公開瀏覽**。
- 由嵌入（向量搜尋）而非僅僅關鍵字驅動的**搜尋**。
- 具有 semver、變更日誌和標籤（包括 `latest`）的**版本控制**。
- 每個版本的 zip 格式**下載**。
- 用於社群回饋的**星標和評論**。
- 用於批准和審核的**管理**掛鉤。
- 用於自動化和指令碼的 **CLI 友善 API**。

## 安全與管理

ClawHub 預設是開放的。任何人都可以上傳技能，但 GitHub 帳號必須至少一週大才能發布。這有助於減緩濫用行為，同時不阻礙合法的貢獻者。

報告和管理：

- 任何登入的使用者都可以舉報技能。
- 舉報原因必須提供並記錄。
- 每位使用者一次最多可有 20 份有效報告。
- 預設情況下，具有超過 3 份唯一報告的技能會自動隱藏。
- 管理員可以查看隱藏的技能、取消隱藏、刪除或封鎖使用者。
- 濫用舉報功能可能導致帳號被封鎖。

有興趣成為管理員嗎？請在 OpenClaw Discord 中詢問並聯繫管理員或維護人員。

## CLI 命令和參數

全域選項（適用於所有命令）：

- `--workdir <dir>`：工作目錄（預設：目前目錄；回溯到 OpenClaw 工作區）。
- `--dir <dir>`：技能目錄，相對於工作目錄（預設：`skills`）。
- `--site <url>`：網站基本 URL（瀏覽器登入）。
- `--registry <url>`：註冊中心 API 基本 URL。
- `--no-input`：禁用提示（非互動式）。
- `-V, --cli-version`：列印 CLI 版本。

憑證：

- `clawhub login` (瀏覽器流程) 或 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

選項：

- `--token <token>`：貼上 API 權杖。
- `--label <label>`：儲存用於瀏覽器登入權杖的標籤（預設：`CLI token`）。
- `--no-browser`：不開啟瀏覽器（需要 `--token`）。

搜尋：

- `clawhub search "query"`
- `--limit <n>`：最大結果數。

安裝：

- `clawhub install <slug>`
- `--version <version>`：安裝特定版本。
- `--force`：如果資料夾已存在則覆寫。

更新：

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`：更新到特定版本（僅限單一 slug）。
- `--force`：當本地檔案與任何已發布版本不匹配時覆寫。

清單：

- `clawhub list` (讀取 `.clawhub/lock.json`)

發布：

- `clawhub publish <path>`
- `--slug <slug>`：技能 slug。
- `--name <name>`：顯示名稱。
- `--version <version>`：Semver 版本。
- `--changelog <text>`：變更日誌文字（可為空）。
- `--tags <tags>`：逗號分隔的標籤（預設：`latest`）。

刪除/取消刪除（僅限所有者/管理員）：

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

同步（掃描本地技能 + 發布新/已更新）：

- `clawhub sync`
- `--root <dir...>`：額外的掃描根目錄。
- `--all`：在沒有提示的情況下上傳所有內容。
- `--dry-run`：顯示將上傳的內容。
- `--bump <type>`：更新的 `patch|minor|major`（預設：`patch`）。
- `--changelog <text>`：用於非互動式更新的變更日誌。
- `--tags <tags>`：逗號分隔的標籤（預設：`latest`）。
- `--concurrency <n>`：註冊中心檢查（預設：4）。

## 智慧代理的常見工作流程

### 搜尋技能

```bash
clawhub search "postgres backups"
```

### 下載新技能

```bash
clawhub install my-skill-pack
```

### 更新已安裝的技能

```bash
clawhub update --all
```

### 備份您的技能（發布或同步）

對於單一技能資料夾：

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

一次掃描和備份多個技能：

```bash
clawhub sync --all
```

## 進階詳細資訊（技術性）

### 版本控制和標籤

- 每次發布都會建立一個新的 **semver** `SkillVersion`。
- 標籤（例如 `latest`）指向一個版本；移動標籤可以讓您回溯。
- 變更日誌會附加到每個版本，並且在同步或發布更新時可以為空。

### 本地變更與註冊中心版本

更新會使用內容雜湊將本地技能內容與註冊中心版本進行比較。如果本地檔案與任何已發布版本不匹配，CLI 會在覆寫前詢問（或在非互動式執行中要求 `--force`）。

### 同步掃描和回溯根目錄

`clawhub sync` 會首先掃描您目前的工作目錄。如果未找到技能，它會回溯到已知的舊版位置（例如 `~/openclaw/skills` 和 `~/.openclaw/skills`）。這是為了在沒有額外旗標的情況下找到較舊的技能安裝。

### 儲存和鎖定檔案

- 已安裝的技能會記錄在您工作目錄下的 `.clawhub/lock.json` 中。
- 憑證權杖儲存在 ClawHub CLI 設定檔案中（透過 `CLAWHUB_CONFIG_PATH` 覆寫）。

### 遙測（安裝計數）

當您登入並執行 `clawhub sync` 時，CLI 會傳送一個最小快照來計算安裝計數。您可以完全禁用此功能：

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 環境變數

- `CLAWHUB_SITE`：覆寫網站 URL。
- `CLAWHUB_REGISTRY`：覆寫註冊中心 API URL。
- `CLAWHUB_CONFIG_PATH`：覆寫 CLI 儲存權杖/設定的位置。
- `CLAWHUB_WORKDIR`：覆寫預設工作目錄。
- `CLAWHUB_DISABLE_TELEMETRY=1`：在 `sync` 時禁用遙測。
