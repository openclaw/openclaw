---
summary: "ClawHub 指南：公開 Skills 登錄庫 + CLI 工作流程"
read_when:
  - 向新使用者介紹 ClawHub
  - Installing, searching, or publishing skills
  - 說明 ClawHub CLI 旗標與同步行為
title: "ClawHub"
---

# ClawHub

ClawHub 是 **OpenClaw 的公開 Skills 登錄庫**。這是一項免費服務：所有 Skills 都是公開、開放，並且對所有人可見，方便分享與重複使用。一個 Skill 本質上只是一個資料夾，內含一個 `SKILL.md` 檔案（以及支援用的文字檔）。你可以在網頁應用程式中瀏覽 Skills，或使用 CLI 來搜尋、安裝、更新與發佈 Skills。 32. 技能只是一個包含 `SKILL.md` 檔案（以及支援的文字檔）的資料夾。 A skill is just a folder with a `SKILL.md` file (plus supporting text files). You can browse skills in the web app or use the CLI to search, install, update, and publish skills.

網站：[clawhub.ai](https://clawhub.ai)

## ClawHub 是什麼

- OpenClaw Skills 的公開登錄庫。
- A versioned store of skill bundles and metadata.
- A discovery surface for search, tags, and usage signals.

## How it works

1. 28. 使用者發佈一個技能套件（檔案 + 中繼資料）。
2. ClawHub stores the bundle, parses metadata, and assigns a version.
3. 登錄庫會為該 Skill 建立搜尋與探索索引。
4. 使用者在 OpenClaw 中瀏覽、下載並安裝 Skills。

## 你可以做什麼

- 發佈新的 Skills，以及既有 Skills 的新版本。
- 依名稱、標籤或搜尋探索 Skills。
- Download skill bundles and inspect their files.
- 回報具濫用性或不安全的 Skills。
- 若你是版主，可進行隱藏、取消隱藏、刪除或封鎖。

## 29. 適用對象（新手友善）

如果你想為 OpenClaw 代理程式加入新能力，ClawHub 是尋找與安裝 Skills 最簡單的方式。你不需要了解後端如何運作。你可以： You do not need to know how the backend works. You can:

- 使用自然語言搜尋 Skills。
- 將 Skill 安裝到你的工作區。
- 之後用一個指令更新 Skills。
- 透過發佈來備份你自己的 Skills。

## 快速開始（非技術）

1. 安裝 CLI（見下一節）。
2. 搜尋你需要的功能：
   - `clawhub search "calendar"`
3. 安裝一個 Skill：
   - `clawhub install <skill-slug>`
4. 啟動一個新的 OpenClaw 工作階段，讓它載入新的 Skill。

## 安裝 CLI

擇一：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## 與 OpenClaw 的整合方式

By default, the CLI installs skills into `./skills` under your current working directory. If a OpenClaw workspace is configured, `clawhub` falls back to that workspace unless you override `--workdir` (or `CLAWHUB_WORKDIR`). OpenClaw loads workspace skills from `<workspace>/skills` and will pick them up in the **next** session. If you already use `~/.openclaw/skills` or bundled skills, workspace skills take precedence.

如需了解 Skills 如何被載入、共享與管控的更多細節，請參閱
[Skills](/tools/skills)。

## Skill 系統概覽

一個 Skill 是一組具版本控制的檔案套件，用來教導 OpenClaw 如何執行特定任務。每次發佈都會建立一個新版本，而登錄庫會保留版本歷史，讓使用者能稽核變更。 Each publish creates a new version, and the registry keeps a
history of versions so users can audit changes.

典型的 Skill 內容包括：

- 一個 `SKILL.md` 檔案，包含主要說明與使用方式。
- Optional configs, scripts, or supporting files used by the skill.
- Metadata such as tags, summary, and install requirements.

ClawHub uses metadata to power discovery and safely expose skill capabilities.
The registry also tracks usage signals (such as stars and downloads) to improve
ranking and visibility.

## 服務提供內容（功能）

- **公開瀏覽** Skills 及其 `SKILL.md` 內容。
- **搜尋** 採用嵌入（向量搜尋），不僅限於關鍵字。
- **版本控制**，包含 semver、變更記錄與標籤（包含 `latest`）。
- **下載**：每個版本提供 zip 檔。
- **Stars and comments** for community feedback.
- **Moderation** hooks for approvals and audits.
- **CLI 友善 API**，便於自動化與腳本使用。

## 安全性與內容管理

ClawHub is open by default. Anyone can upload skills, but a GitHub account must
be at least one week old to publish. This helps slow down abuse without blocking
legitimate contributors.

Reporting and moderation:

- 任何已登入的使用者都可以回報 Skill。
- Report reasons are required and recorded.
- 每位使用者同時間最多可有 20 筆有效回報。
- 超過 3 位不同使用者回報的 Skills，預設會自動隱藏。
- 版主可檢視已隱藏的 Skills，並進行取消隱藏、刪除或封鎖使用者。
- Abusing the report feature can result in account bans.

Interested in becoming a moderator? 有興趣成為版主嗎？請在 OpenClaw Discord 中詢問，並聯絡版主或維護者。

## CLI 指令與參數

全域選項（適用於所有指令）：

- `--workdir <dir>`：工作目錄（預設：目前目錄；會回退至 OpenClaw 工作區）。
- `--dir <dir>`：Skills 目錄，相對於 workdir（預設：`skills`）。
- `--site <url>`：網站基礎 URL（瀏覽器登入）。
- `--registry <url>`：登錄庫 API 基礎 URL。
- `--no-input`：停用提示（非互動模式）。
- `-V, --cli-version`：輸出 CLI 版本。

Auth:

- `clawhub login`（瀏覽器流程）或 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

選項：

- `--token <token>`：貼上 API 權杖。
- `--label <label>`：為瀏覽器登入權杖儲存的標籤（預設：`CLI token`）。
- `--no-browser`：不開啟瀏覽器（需要 `--token`）。

搜尋：

- `clawhub search "query"`
- `--limit <n>`：最大結果數。

安裝：

- `clawhub install <slug>`
- `--version <version>`：安裝指定版本。
- `--force`：若資料夾已存在則覆寫。

更新：

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`：更新至指定版本（僅限單一 slug）。
- `--force`: Overwrite when local files do not match any published version.

列表：

- `clawhub list`（讀取 `.clawhub/lock.json`）

Publish:

- `clawhub publish <path>`
- `--slug <slug>`：Skill slug。
- `--name <name>`：顯示名稱。
- `--version <version>`：Semver 版本。
- `--changelog <text>`：變更記錄文字（可為空）。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。

刪除／取消刪除（僅限擁有者／管理員）：

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

同步（掃描本機 Skills + 發佈新增／更新）：

- `clawhub sync`
- `--root <dir...>`：額外的掃描根目錄。
- `--all`：不經提示直接上傳全部內容。
- `--dry-run`：顯示將會上傳的內容。
- `--bump <type>`：更新時使用 `patch|minor|major`（預設：`patch`）。
- `--changelog <text>`：非互動更新的變更記錄。
- `--tags <tags>`：以逗號分隔的標籤（預設：`latest`）。
- `--concurrency <n>`：登錄庫檢查次數（預設：4）。

## 代理程式的常見工作流程

### 搜尋 Skills

```bash
clawhub search "postgres backups"
```

### 下載新 Skills

```bash
clawhub install my-skill-pack
```

### 更新已安裝的 Skills

```bash
clawhub update --all
```

### 備份你的 Skills（發佈或同步）

針對單一 Skill 資料夾：

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

一次掃描並備份多個 Skills：

```bash
clawhub sync --all
```

## 進階細節（技術）

### 版本與標籤

- 每次發佈都會建立新的 **semver** `SkillVersion`。
- 標籤（例如 `latest`）會指向某個版本；移動標籤即可回復版本。
- Changelogs are attached per version and can be empty when syncing or publishing updates.

### Local changes vs registry versions

Updates compare the local skill contents to registry versions using a content hash. If local files do not match any published version, the CLI asks before overwriting (or requires `--force` in non-interactive runs).

### 同步掃描與回退根目錄

`clawhub sync` scans your current workdir first. If no skills are found, it falls back to known legacy locations (for example `~/openclaw/skills` and `~/.openclaw/skills`). This is designed to find older skill installs without extra flags.

### 儲存與鎖定檔

- 已安裝的 Skills 會記錄在 workdir 下的 `.clawhub/lock.json`。
- 身分驗證權杖會儲存在 ClawHub CLI 設定檔中（可透過 `CLAWHUB_CONFIG_PATH` 覆寫）。

### 遙測（安裝計數）

當你在已登入狀態下執行 `clawhub sync`，CLI 會傳送最小化的快照以計算安裝次數。你可以完全停用此功能： You can disable this entirely:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 環境變數

- `CLAWHUB_SITE`：覆寫網站 URL。
- `CLAWHUB_REGISTRY`：覆寫登錄庫 API URL。
- `CLAWHUB_CONFIG_PATH`：覆寫 CLI 儲存權杖／設定的位置。
- `CLAWHUB_WORKDIR`：覆寫預設 workdir。
- `CLAWHUB_DISABLE_TELEMETRY=1`：在 `sync` 上停用遙測。
