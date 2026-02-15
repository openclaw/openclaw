---
summary: "ClawHub 指南：公開 Skills 註冊表 + CLI 工作流"
read_when:
  - 向新使用者介紹 ClawHub
  - 安裝、搜尋或發佈 Skills
  - 解釋 ClawHub CLI 旗標與同步行為
title: "ClawHub"
---

# ClawHub

ClawHub 是 **OpenClaw 的公開 Skills 註冊表**。這是一項免費服務：所有 Skills 都是公開、開放且對所有人可見的，以便分享與重複使用。Skill 只是包含 `SKILL.md` 檔案（以及輔助文字檔）的資料夾。您可以在網頁應用程式中瀏覽 Skills，或使用 CLI 來搜尋、安裝、更新及發佈 Skills。

網站：[clawhub.ai](https://clawhub.ai)

## ClawHub 是什麼

- OpenClaw Skills 的公開註冊表。
- 具備版本控制的 Skill 套件與詮釋資料（metadata）儲存庫。
- 用於搜尋、標籤和使用情形訊號的探索介面。

## 運作方式

1. 使用者發佈一個 Skill 套件（檔案 + 詮釋資料）。
2. ClawHub 儲存該套件、解析詮釋資料並分配版本號。
3. 註冊表為該 Skill 建立索引以供搜尋與探索。
4. 使用者在 OpenClaw 中瀏覽、下載並安裝 Skills。

## 您可以做什麼

- 發佈新的 Skills 以及現有 Skills 的新版本。
- 透過名稱、標籤或搜尋來探索 Skills。
- 下載 Skill 套件並檢查其檔案。
- 檢舉濫用或不安全的 Skills。
- 如果您是管理員，可以隱藏、取消隱藏、刪除或封鎖。

## 適用對象（新手友善）

如果您想為您的 OpenClaw 智慧代理添加新功能，ClawHub 是尋找並安裝 Skills 最簡單的方式。您不需要了解後端如何運作。您可以：

- 以自然語言搜尋 Skills。
- 將 Skill 安裝到您的工作區。
- 日後只需一個指令即可更新 Skills。
- 透過發佈來備份您自己的 Skills。

## 快速開始（非技術類）

1. 安裝 CLI（請參閱下一節）。
2. 搜尋您需要的內容：
   - `clawhub search "calendar"`
3. 安裝 Skill：
   - `clawhub install <skill-slug>`
4. 啟動新的 OpenClaw 工作階段，使其載入新的 Skill。

## 安裝 CLI

擇一執行：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## 如何融入 OpenClaw

預設情況下，CLI 會將 Skills 安裝到您目前工作目錄下的 `./skills`。如果已設定 OpenClaw 工作區，`clawhub` 會自動使用該工作區，除非您使用 `--workdir`（或 `CLAWHUB_WORKDIR`）進行覆蓋。OpenClaw 會從 `<workspace>/skills` 載入工作區 Skills，並在**下一個**工作階段中生效。如果您已經在使用 `~/.openclaw/skills` 或內建的 Skills，工作區 Skills 將優先採用。

關於 Skills 如何載入、分享與管控的詳細資訊，請參閱
[Skills](/tools/skills)。

## Skill 系統概述

Skill 是具有版本的檔案套件，教導 OpenClaw 如何執行特定任務。每次發佈都會建立一個新版本，註冊表會保留版本歷史記錄，以便使用者稽核變更。

一個典型的 Skill 包含：

- 一個包含主要說明與用法說明的 `SKILL.md` 檔案。
- 該 Skill 使用的可選設定、腳本或輔助檔案。
- 詮釋資料，例如標籤、摘要和安裝需求。

ClawHub 利用詮釋資料來驅動探索功能，並安全地展示 Skill 的能力。註冊表還會追蹤使用情形訊號（例如星星數和下載量），以優化排名和曝光度。

## 服務提供的功能

- **公開瀏覽** Skills 及其 `SKILL.md` 內容。
- 透過嵌入（embeddings，向量搜尋）驅動的**搜尋**，而不僅僅是關鍵字。
- 具備語法版本（semver）、變更日誌（changelogs）和標籤（包括 `latest`）的**版本管理**。
- 以壓縮檔（zip）形式提供各版本的**下載**。
- 提供社群回饋的**星星與評論**。
- 用於審核與稽核的**管理**掛鉤（hooks）。
- 適用於自動化與腳本編寫的 **CLI 友善 API**。

## 安全與管理

ClawHub 預設是開放的。任何人都可以上傳 Skills，但 GitHub 帳號必須註冊滿一週才能發佈。這有助於減緩濫用，同時不阻礙合法的貢獻者。

檢舉與管理：

- 任何已登入的使用者都可以檢舉 Skill。
- 檢舉原因為必填並會被記錄。
- 每位使用者一次最多可擁有 20 個進行中的檢舉。
- 擁有超過 3 個不重複檢舉的 Skills 預設會被自動隱藏。
- 管理員可以查看隱藏的 Skills、取消隱藏、刪除或封鎖使用者。
- 濫用檢舉功能可能會導致帳號被封鎖。

有興趣成為管理員嗎？請在 OpenClaw Discord 中詢問並聯繫管理員或維護者。

## CLI 指令與參數

全域選項（適用於所有指令）：

- `--workdir <dir>`：工作目錄（預設：目前目錄；若無則回退至 OpenClaw 工作區）。
- `--dir <dir>`：Skills 目錄，相對於工作目錄（預設：`skills`）。
- `--site <url>`：網站基礎 URL（瀏覽器登入）。
- `--registry <url>`：註冊表 API 基礎 URL。
- `--no-input`：停用提示（非互動模式）。
- `-V, --cli-version`：顯示 CLI 版本。

憑證（Auth）：

- `clawhub login`（瀏覽器流程）或 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

選項：

- `--token <token>`：貼上 API 權杖（token）。
- `--label <label>`：為瀏覽器登入權杖儲存的標籤（預設：`CLI token`）。
- `--no-browser`：不開啟瀏覽器（需要 `--token`）。

搜尋：

- `clawhub search "query"`
- `--limit <n>`：最大結果數量。

安裝：

- `clawhub install <slug>`
- `--version <version>`：安裝特定版本。
- `--force`：如果資料夾已存在則覆蓋。

更新：

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`：更新至特定版本（僅限單個 slug）。
- `--force`：當本地檔案與任何已發佈版本不符時強制覆蓋。

列表：

- `clawhub list`（讀取 `.clawhub/lock.json`）

發佈：

- `clawhub publish <path>`
- `--slug <slug>`：Skill slug。
- `--name <name>`：顯示名稱。
- `--version <version>`：語法版本（semver）。
- `--changelog <text>`：變更日誌內容（可為空）。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。

刪除/取消刪除（僅限擁有者/管理員）：

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

同步（掃描本地 Skills + 發佈新/已更新項目）：

- `clawhub sync`
- `--root <dir...>`：額外的掃描根目錄。
- `--all`：不經提示直接上傳所有內容。
- `--dry-run`：顯示將要上傳的內容。
- `--bump <type>`：更新類型為 `patch|minor|major`（預設：`patch`）。
- `--changelog <text>`：非互動式更新的變更日誌。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。
- `--concurrency <n>`：註冊表檢查的並行數（預設：4）。

## 智慧代理的常見工作流

### 搜尋 Skills

```bash
clawhub search "postgres backups"
```

### 下載新的 Skills

```bash
clawhub install my-skill-pack
```

### 更新已安裝的 Skills

```bash
clawhub update --all
```

### 備份您的 Skills（發佈或同步）

單個 Skill 資料夾：

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

一次掃描並備份多個 Skills：

```bash
clawhub sync --all
```

## 進階細節（技術類）

### 版本管理與標籤

- 每次發佈都會建立一個新的 **semver** `SkillVersion`。
- 標籤（如 `latest`）指向某個版本；移動標籤可讓您進行回滾（roll back）。
- 變更日誌附於每個版本，同步或發佈更新時可為空。

### 本地變更 vs 註冊表版本

更新時會使用內容雜湊（hash）將本地 Skill 內容與註冊表版本進行比較。如果本地檔案與任何已發佈版本均不相符，CLI 會在覆蓋前詢問（或在非互動模式下要求 `--force`）。

### 同步掃描與回退根目錄

`clawhub sync` 首先掃描您目前的工作目錄（workdir）。如果未發現 Skills，它會回退至已知的舊版路徑（例如 `~/openclaw/skills` 和 `~/.openclaw/skills`）。這是為了在不使用額外旗標的情況下找到舊有的 Skill 安裝。

### 儲存空間與鎖定檔

- 已安裝的 Skills 會記錄在工作目錄下的 `.clawhub/lock.json` 中。
- 驗證權杖儲存在 ClawHub CLI 設定檔中（可透過 `CLAWHUB_CONFIG_PATH` 覆蓋）。

### 遙測（安裝次數統計）

當您在登入狀態下執行 `clawhub sync` 時，CLI 會傳送極簡的快照以計算安裝次數。您可以完全停用此功能：

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 環境變數

- `CLAWHUB_SITE`：覆蓋網站 URL。
- `CLAWHUB_REGISTRY`：覆蓋註冊表 API URL。
- `CLAWHUB_CONFIG_PATH`：覆蓋 CLI 儲存權杖/設定的路徑。
- `CLAWHUB_WORKDIR`：覆蓋預設工作目錄。
- `CLAWHUB_DISABLE_TELEMETRY=1`：停用 `sync` 時的遙測。
