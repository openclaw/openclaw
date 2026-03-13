---
summary: "ClawHub guide: public skills registry + CLI workflows"
read_when:
  - Introducing ClawHub to new users
  - "Installing, searching, or publishing skills"
  - Explaining ClawHub CLI flags and sync behavior
title: ClawHub
---

# ClawHub

ClawHub 是 **OpenClaw 的公開技能註冊中心**。這是一項免費服務：所有技能都是公開、開放且對所有人可見，方便分享與重複使用。技能本質上就是一個包含 `SKILL.md` 檔案（以及輔助文字檔）的資料夾。你可以在網頁應用程式中瀏覽技能，或使用 CLI 來搜尋、安裝、更新和發佈技能。

網站： [clawhub.ai](https://clawhub.ai)

## ClawHub 是什麼

- OpenClaw 技能的公開註冊中心。
- 技能套件與元資料的版本化儲存庫。
- 用於搜尋、標籤和使用訊號的發現平台。

## 運作方式

1. 使用者發佈技能套件（檔案 + 元資料）。
2. ClawHub 儲存套件，解析元資料並指派版本。
3. 註冊中心將技能編入索引以供搜尋與發現。
4. 使用者在 OpenClaw 中瀏覽、下載並安裝技能。

## 你可以做什麼

- 發佈新技能及現有技能的新版本。
- 透過名稱、標籤或搜尋來發現技能。
- 下載技能套件並檢視其檔案。
- 舉報濫用或不安全的技能。
- 如果你是管理員，可以隱藏、取消隱藏、刪除或封鎖技能。

## 適合對象（初學者友善）

如果你想為你的 OpenClaw 代理新增功能，ClawHub 是尋找和安裝技能最簡單的方式。你不需要了解後端運作原理。你可以：

- 用自然語言搜尋技能。
- 將技能安裝到你的工作區。
- 之後用一條指令更新技能。
- 透過發佈技能備份你自己的技能。

## 快速開始（非技術者）

1. 安裝 CLI（請參考下一節）。
2. 搜尋你需要的技能：
   - `clawhub search "calendar"`
3. 安裝技能：
   - `clawhub install <skill-slug>`
4. 啟動新的 OpenClaw 會話，讓它載入新技能。

## 安裝 CLI

選擇一個：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## 它如何融入 OpenClaw

預設情況下，CLI 會將技能安裝到您目前工作目錄下的 `./skills`。如果已設定 OpenClaw 工作區，`clawhub` 會回退到該工作區，除非您覆寫了 `--workdir`（或 `CLAWHUB_WORKDIR`）。OpenClaw 會從 `<workspace>/skills` 載入工作區技能，並會在**下一次**會話中啟用它們。如果您已經使用 `~/.openclaw/skills` 或內建技能，工作區技能將優先使用。

欲了解技能如何載入、共享及管控的詳細資訊，請參考
[技能](/tools/skills)。

## 技能系統概述

技能是一組有版本控制的檔案包，教導 OpenClaw 如何執行特定任務。每次發佈都會建立一個新版本，註冊中心會保留版本歷史，方便使用者審核變更。

典型的技能包含：

- 一個包含主要描述和用法的 `SKILL.md` 檔案。
- 可選的設定檔、腳本或技能所需的支援檔案。
- 元資料，如標籤、摘要及安裝需求。

ClawHub 利用元資料來強化技能的發現功能並安全地揭露技能能力。註冊中心也會追蹤使用訊號（例如星數和下載量）以提升排名和能見度。

## 服務提供的功能

- **公開瀏覽**技能及其 `SKILL.md` 內容。
- 以嵌入式向量搜尋（vector search）為基礎的**搜尋**，不僅限於關鍵字。
- 具備 semver 版本控制、變更日誌及標籤（包含 `latest`）。
- 每個版本可下載為 zip 檔。
- 社群反饋的星標與評論功能。
- 審核機制的掛勾，用於批准與稽核。
- 適合 CLI 使用的 API，方便自動化與腳本操作。

## 安全性與審核

ClawHub 預設為開放狀態。任何人都可以上傳技能，但發佈者的 GitHub 帳號必須至少存在一週。此措施有助於減緩濫用，同時不阻擋合法貢獻者。

舉報與審核：

- 任何已登入的使用者都可以舉報技能。
- 舉報原因為必填且會被記錄。
- 每位使用者最多可同時擁有 20 筆有效舉報。
- 被超過 3 位不同使用者舉報的技能，預設會自動隱藏。
- 管理員可以查看隱藏的技能、取消隱藏、刪除技能或封鎖使用者。
- 濫用舉報功能可能導致帳號被封鎖。

有興趣成為管理員嗎？請在 OpenClaw Discord 詢問，並聯繫管理員或維護者。

## CLI 指令與參數

全域選項（適用於所有指令）：

- `--workdir <dir>`：工作目錄（預設為目前目錄；若無則回退至 OpenClaw 工作區）。
- `--dir <dir>`：技能目錄，相對於工作目錄（預設為 `skills`）。
- `--site <url>`：網站基底 URL（瀏覽器登入用）。
- `--registry <url>`：註冊表 API 基底 URL。
- `--no-input`：停用提示（非互動模式）。
- `-V, --cli-version`：列印 CLI 版本。

認證：

- `clawhub login`（瀏覽器流程）或 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

選項：

- `--token <token>`：貼上 API token。
- `--label <label>`：瀏覽器登入 token 的標籤（預設為 `CLI token`）。
- `--no-browser`：不開啟瀏覽器（需搭配 `--token`）。

搜尋：

- `clawhub search "query"`
- `--limit <n>`：最大結果數。

安裝：

- `clawhub install <slug>`
- `--version <version>`：安裝指定版本。
- `--force`：若資料夾已存在則覆蓋。

更新：

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`：更新至特定版本（僅限單一 slug）。
- `--force`：當本地檔案與任何已發佈版本不符時覆寫。

列表：

- `clawhub list`（讀取 `.clawhub/lock.json`）

發佈：

- `clawhub publish <path>`
- `--slug <slug>`：技能 slug。
- `--name <name>`：顯示名稱。
- `--version <version>`：Semver 版本。
- `--changelog <text>`：更新日誌文字（可為空）。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。

刪除／復原（僅限擁有者／管理員）：

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

同步（掃描本地技能 + 發佈新增／更新）：

- `clawhub sync`
- `--root <dir...>`：額外掃描根目錄。
- `--all`：無提示上傳所有內容。
- `--dry-run`：顯示將會上傳的內容。
- `--bump <type>`：更新時使用 `patch|minor|major`（預設：`patch`）。
- `--changelog <text>`：非互動式更新的更新日誌。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。
- `--concurrency <n>`：註冊表檢查次數（預設：4）。

## 代理的常見工作流程

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

### 備份你的技能（發佈或同步）

針對單一技能資料夾：

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

一次掃描並備份多個技能：

```bash
clawhub sync --all
```

## 進階細節（技術面）

### 版本控制與標籤

- 每次發佈都會建立一個新的 **semver** `SkillVersion`。
- 標籤（例如 `latest`）會指向某個版本；移動標籤可以讓你回滾版本。
- 變更日誌會附加在每個版本上，且在同步或發佈更新時可以是空的。

### 本地變更與註冊版本比較

更新時會使用內容雜湊比對本地技能內容與註冊版本。如果本地檔案與任何已發佈版本不符，CLI 會在覆寫前詢問（非互動模式下則需要 `--force`）。

### 同步掃描與備援根目錄

`clawhub sync` 會先掃描你目前的工作目錄。如果找不到技能，會退回掃描已知的舊版路徑（例如 `~/openclaw/skills` 和 `~/.openclaw/skills`）。此設計用於在不需額外參數的情況下找到較舊的技能安裝。

### 儲存與鎖定檔案

- 已安裝的技能會記錄在你工作目錄下的 `.clawhub/lock.json`。
- 認證 token 則儲存在 ClawHub CLI 的設定檔中（可透過 `CLAWHUB_CONFIG_PATH` 覆寫）。

### 遙測（安裝次數）

當你在登入狀態下執行 `clawhub sync` 時，CLI 會傳送一個最小快照以計算安裝次數。你可以完全停用此功能：

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 環境變數

- `CLAWHUB_SITE`：覆寫網站 URL。
- `CLAWHUB_REGISTRY`：覆寫註冊表 API URL。
- `CLAWHUB_CONFIG_PATH`：覆寫 CLI 儲存 token/設定的位置。
- `CLAWHUB_WORKDIR`：覆寫預設工作目錄。
- `CLAWHUB_DISABLE_TELEMETRY=1`：在 `sync` 上停用遙測。
