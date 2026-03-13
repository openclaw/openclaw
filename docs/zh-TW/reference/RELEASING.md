---
title: Release Checklist
summary: Step-by-step release checklist for npm + macOS app
read_when:
  - Cutting a new npm release
  - Cutting a new macOS app release
  - Verifying metadata before publishing
---

# 發行檢查清單（npm + macOS）

預設從專案根目錄使用 `pnpm` 搭配 Node 24。Node 22 LTS，目前為 `22.16+`，仍維持相容性支援。標記/發佈前請保持工作目錄乾淨。

## 操作者觸發

當操作者說「release」時，立即執行此預檢（除非被阻擋，否則不問額外問題）：

- 閱讀本文件及 `docs/platforms/mac/release.md`。
- 從 `~/.profile` 載入環境變數，並確認 `SPARKLE_PRIVATE_KEY_FILE` 及 App Store Connect 變數已設定（SPARKLE_PRIVATE_KEY_FILE 應放在 `~/.profile`）。
- 如有需要，使用 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 的 Sparkle 金鑰。

## 版本管理

目前 OpenClaw 發行版本採用日期版本控制。

- 穩定版版本號：`YYYY.M.D`
  - Git 標籤：`vYYYY.M.D`
  - 專案歷史範例：`v2026.2.26`、`v2026.3.8`
- Beta 預發行版本號：`YYYY.M.D-beta.N`
  - Git 標籤：`vYYYY.M.D-beta.N`
  - 專案歷史範例：`v2026.2.15-beta.1`、`v2026.3.8-beta.1`
- 在所有地方使用相同版本字串，Git 標籤不使用的地方去除前導 `v`：
  - `package.json`：`2026.3.8`
  - Git 標籤：`v2026.3.8`
  - GitHub 發行標題：`openclaw 2026.3.8`
- 月份和日期不補零。使用 `2026.3.8`，非 `2026.03.08`。
- 穩定版和 Beta 是 npm dist-tag，不是獨立發行線：
  - `latest` = 穩定版
  - `beta` = 預發行/測試版
- Dev 是 `main` 的持續開發分支，不是一般 git 標籤發行。
- 發行流程會強制目前穩定版/ Beta 標籤格式，並拒絕 CalVer 日期與發行日期相差超過 2 個 UTC 日曆天的版本。

歷史備註：

- 專案歷史中存在較舊標籤如 `v2026.1.11-1`、`v2026.2.6-3` 和 `v2.0.0-beta2`。
- 將這些視為舊版標籤格式。新版本應使用 `vYYYY.M.D` 作為穩定版，`vYYYY.M.D-beta.N` 作為 Beta。

1. **版本與元資料**

- [ ] 提升 `package.json` 版本（例如 `2026.1.29`）。
- [ ] 執行 `pnpm plugins:sync` 以同步擴充套件版本與更新日誌。
- [ ] 更新 [`src/version.ts`](https://github.com/openclaw/openclaw/blob/main/src/version.ts) 中的 CLI/版本字串，以及 [`src/web/session.ts`](https://github.com/openclaw/openclaw/blob/main/src/web/session.ts) 中 Baileys 使用者代理。
- [ ] 確認套件元資料（名稱、描述、倉庫、關鍵字、授權）及 `bin` 映射指向 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) 以供 `openclaw` 使用。
- [ ] 若依賴有變更，執行 `pnpm install` 以確保 `pnpm-lock.yaml` 是最新。

2. **建置與產物**

- [ ] 若 A2UI 輸入有變更，執行 `pnpm canvas:a2ui:bundle` 並提交更新後的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build`（重新產生 `dist/`）。
- [ ] 確認 npm 套件 `files` 包含所有必要的 `dist/*` 資料夾（特別是用於無頭 node 與 ACP CLI 的 `dist/node-host/**` 和 `dist/acp/**`）。
- [ ] 確認 `dist/build-info.json` 存在且包含預期的 `commit` 雜湊（CLI 橫幅用於 npm 安裝）。
- [ ] 選擇性：建置後執行 `npm pack --pack-destination /tmp`；檢查 tarball 內容並備用於 GitHub 發行（**不要**提交）。

3. **更新日誌與文件**

- [ ] 更新 `CHANGELOG.md`，加入面向使用者的重點（若檔案不存在則建立）；條目依版本嚴格由新到舊排序。
- [ ] 確認 README 範例/參數與目前 CLI 行為一致（特別是新指令或選項）。

4. **驗證**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（或若需覆蓋率輸出則用 `pnpm test:coverage`）
- [ ] `pnpm release:check`（驗證 npm pack 內容）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker 安裝冒煙測試，快速路徑；發佈前必須）
  - 若前一個 npm 發佈已知有問題，則在預安裝步驟設定 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。
- [ ] （選用）完整安裝器冒煙測試（新增非 root + CLI 覆蓋率）：`pnpm test:install:smoke`
- [ ] （選用）安裝器端對端測試（Docker，執行 `curl -fsSL https://openclaw.ai/install.sh | bash`，上線，然後執行真實工具呼叫）：
  - `pnpm test:install:e2e:openai`（需 `OPENAI_API_KEY`）
  - `pnpm test:install:e2e:anthropic`（需 `ANTHROPIC_API_KEY`）
  - `pnpm test:install:e2e`（需兩組金鑰；執行兩個供應商）
- [ ] （選用）若變更影響傳送/接收路徑，抽查網頁閘道。

5. **macOS 應用程式（Sparkle）**

- [ ] 建置並簽署 macOS 應用程式，然後壓縮成 zip 供發佈。
- [ ] 產生 Sparkle appcast（HTML 註記，透過 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)）並更新 `appcast.xml`。
- [ ] 保留應用程式 zip（及選用的 dSYM zip）以便附加至 GitHub 發佈。
- [ ] 遵循 [macOS 發佈](/platforms/mac/release) 指令與必要環境變數。
  - `APP_BUILD` 必須是數字且單調遞增（不可有 `-beta`），以便 Sparkle 正確比較版本。
  - 若要進行公證，請使用由 App Store Connect API 環境變數建立的 `openclaw-notary` 金鑰鏈設定檔（參見 [macOS 發佈](/platforms/mac/release)）。

6. **發佈（npm）**

- [ ] 確認 git 狀態乾淨；必要時提交並推送。
- [ ] 確認 `openclaw` 套件已設定 npm 信任發佈。
- [ ] 推送相符的 git 標籤以觸發 `.github/workflows/openclaw-npm-release.yml`。
  - 穩定標籤會發佈到 npm `latest`。
  - Beta 標籤會發佈到 npm `beta`。
  - 工作流程會拒絕不符合 `package.json`、不在 `main` 上，或 CalVer 日期與發佈日期相差超過 2 個 UTC 日曆天的標籤。
- [ ] 驗證註冊表：`npm view openclaw version`、`npm view openclaw dist-tags` 和 `npx -y openclaw@X.Y.Z --version`（或 `--help`）。

### 疑難排解（2.0.0-beta2 發佈筆記）

- **npm pack/publish 卡住或產生巨大 tarball**：macOS 應用程式包在 `dist/OpenClaw.app`（及發佈壓縮檔）被誤包含進套件。透過 `package.json` `files` 白名單發佈內容修正（包含 dist 子目錄、文件、技能；排除應用程式包）。用 `npm pack --dry-run` 確認 `dist/OpenClaw.app` 未被列出。
- **npm 認證網頁迴圈於 dist-tags**：使用舊版認證以取得 OTP 提示：
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 驗證失敗，顯示 `ECOMPROMISED: Lock compromised`**：清除快取後重試：
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **標籤需在後期修正後重新指向**：強制更新並推送標籤，然後確保 GitHub 發佈資產仍相符：
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 發佈 + appcast**

- [ ] 標籤並推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（或 `git push --tags`）。
  - 推送標籤同時觸發 npm 發佈工作流程。
- [ ] 為 `vX.Y.Z` 建立/更新 GitHub 發佈，**標題為 `openclaw X.Y.Z`**（非僅標籤）；內容應包含該版本的**完整**變更日誌區段（重點 + 變更 + 修正），內嵌呈現（無裸連結），且**內容中不得重複標題**。
- [ ] 附加產物：`npm pack` tarball（選用）、`OpenClaw-X.Y.Z.zip` 和 `OpenClaw-X.Y.Z.dSYM.zip`（若有產生）。
- [ ] 提交更新後的 `appcast.xml` 並推送（Sparkle 從 main 讀取）。
- [ ] 從乾淨的暫存目錄（無 `package.json`）執行 `npx -y openclaw@X.Y.Z send --help`，確認安裝與 CLI 入口正常。
- [ ] 宣布並分享發佈說明。

## 外掛發佈範圍（npm）

我們只會在 `@openclaw/*` 範圍下發佈**已存在的 npm 外掛**。未在 npm 上的內建外掛則維持**僅限磁碟樹**（仍隨 `extensions/**` 發佈）。

推導清單的流程：

1. 執行 `npm search @openclaw --json` 並擷取套件名稱。
2. 與 `extensions/*/package.json` 名稱比對。
3. 僅發佈**交集**（已在 npm 上的套件）。

目前的 npm 外掛列表（視需要更新）：

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

發行說明也必須特別標示 **新的可選內建外掛**，這些外掛 **預設並未啟用**（例如：`tlon`）。
