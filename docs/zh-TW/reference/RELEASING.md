---
title: "發布檢查清單"
summary: "npm + macOS 應用程式的逐步發布檢查清單"
read_when:
  - 進行新的 npm 發布
  - 進行新的 macOS 應用程式發布
  - 在發布前驗證中繼資料
---

# 發布檢查清單 (npm + macOS)

在儲存庫根目錄使用 `pnpm` (Node 22+)。在標記 (tagging) 或發布前，請確保工作區 (working tree) 是乾淨的。

## 操作員觸發

當操作員說「發布」時，立即執行以下準備工作 (preflight)（除非遇到阻礙，否則不要詢問額外問題）：

- 閱讀此文件與 `docs/platforms/mac/release.md`。
- 從 `~/.profile` 載入環境變數，並確認已設定 `SPARKLE_PRIVATE_KEY_FILE` 與 App Store Connect 變數（`SPARKLE_PRIVATE_KEY_FILE` 應位於 `~/.profile`）。
- 如有需要，請使用位於 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 的 Sparkle 金鑰。

1. **版本與中繼資料**

- [ ] 調整 `package.json` 版本號（例如：`2026.1.29`）。
- [ ] 執行 `pnpm plugins:sync` 以同步擴充功能套件版本與變更日誌 (changelogs)。
- [ ] 更新 CLI/版本字串：[`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 與 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) 中的 Baileys 使用者代理 (user agent)。
- [ ] 確認套件中繼資料（名稱、描述、儲存庫、關鍵字、授權）且 `bin` 對照表將 `openclaw` 指向 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)。
- [ ] 如果依賴項目有變動，請執行 `pnpm install` 以更新 `pnpm-lock.yaml`。

2. **建置與成品 (Artifacts)**

- [ ] 如果 A2UI 輸入有變動，執行 `pnpm canvas:a2ui:bundle` 並提交更新後的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build`（重新產生 `dist/`）。
- [ ] 驗證 npm 套件的 `files` 包含所有必要的 `dist/*` 資料夾（特別是 headless 節點與 ACP CLI 的 `dist/node-host/**` 與 `dist/acp/**`）。
- [ ] 確認 `dist/build-info.json` 存在且包含預期的 `commit` 雜湊值（CLI 橫幅在 npm 安裝時會使用此資訊）。
- [ ] 選用：建置後執行 `npm pack --pack-destination /tmp`；檢查 tarball 內容並妥善保存以供 GitHub 發布使用（**請勿**將其提交）。

3. **變更日誌與文件**

- [ ] 使用面向使用者的亮點更新 `CHANGELOG.md`（如果檔案不存在請建立）；項目請嚴格按照版本降序排列。
- [ ] 確保 README 範例/標記 (flags) 符合目前的 CLI 行為（特別是新指令或選項）。

4. **驗證**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（或若需要覆蓋率輸出，請執行 `pnpm test:coverage`）
- [ ] `pnpm release:check`（驗證 npm pack 內容）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker 安裝冒煙測試，快速路徑；發布前必做）
  - 如果已知前一個 npm 發布版本有問題，請為預先安裝步驟設定 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。
- [ ] （選用）完整的安裝程式冒煙測試（增加非 root + CLI 覆蓋率）：`pnpm test:install:smoke`
- [ ] （選用）安裝程式 E2E 測試（Docker，執行 `curl -fsSL https://openclaw.ai/install.sh | bash`，進行新手導覽，然後執行實際的工具呼叫）：
  - `pnpm test:install:e2e:openai`（需要 `OPENAI_API_KEY`）
  - `pnpm test:install:e2e:anthropic`（需要 `ANTHROPIC_API_KEY`）
  - `pnpm test:install:e2e`（需要兩個金鑰；執行兩個供應商測試）
- [ ] （選用）如果你的變動影響了傳送/接收路徑，請抽查 web Gateway。

5. **macOS 應用程式 (Sparkle)**

- [ ] 建置並簽署 macOS 應用程式，然後將其壓縮 (zip) 以供散佈。
- [ ] 產生 Sparkle appcast（透過 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 產生 HTML 說明）並更新 `appcast.xml`。
- [ ] 準備好應用程式 zip（以及選用的 dSYM zip）以附加到 GitHub 發布。
- [ ] 按照 [macOS release](/platforms/mac/release) 執行確切的指令並設定必要的環境變數。
  - `APP_BUILD` 必須是數字且單調增加（不可包含 `-beta`），以便 Sparkle 正確比較版本。
  - 若要進行公證 (notarizing)，請使用從 App Store Connect API 環境變數建立的 `openclaw-notary` 鑰匙圈設定檔（參見 [macOS release](/platforms/mac/release)）。

6. **發布 (npm)**

- [ ] 確認 git 狀態是乾淨的；根據需要提交並推送。
- [ ] 如有需要請 `npm login`（驗證 2FA）。
- [ ] `npm publish --access public`（預發布版本請使用 `--tag beta`）。
- [ ] 驗證註冊表：`npm view openclaw version`、`npm view openclaw dist-tags` 以及 `npx -y openclaw @X.Y.Z --version`（或 `--help`）。

### 疑難排解（來自 2.0.0-beta2 發布的筆記）

- **npm pack/publish 停滯或產生巨大的 tarball**：`dist/OpenClaw.app` 中的 macOS 應用程式套件（以及發布用的 zip 檔）被包含進套件中。修正方式是透過 `package.json` 的 `files` 欄位將發布內容列入白名單（包含 dist 子目錄、文件、Skills；排除應用程式套件）。使用 `npm pack --dry-run` 確認 `dist/OpenClaw.app` 未被列出。
- **dist-tags 的 npm 認證網頁迴圈**：使用傳統認證方式以取得一次性密碼 (OTP) 提示：
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw @X.Y.Z latest`
- **`npx` 驗證失敗，錯誤訊息為 `ECOMPROMISED: Lock compromised`**：使用乾淨的快取重試：
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw @X.Y.Z --version`
- **在最後修正後需要重新指向標記 (Tag)**：強制更新並推送標記，然後確保 GitHub 發布素材 (assets) 仍然符合：
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 發布 + appcast**

- [ ] 標記並推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（或 `git push --tags`）。
- [ ] 為 `vX.Y.Z` 建立/重新整理 GitHub 發布，**標題為 `openclaw X.Y.Z`**（不只是標記名稱）；內文應包含該版本的**完整**變更日誌章節（亮點 + 變更 + 修正），採內聯方式（不要只放連結），且**標題不得在內文中重複**。
- [ ] 附加成品：`npm pack` tarball（選用）、`OpenClaw-X.Y.Z.zip` 以及 `OpenClaw-X.Y.Z.dSYM.zip`（如果有產生）。
- [ ] 提交更新後的 `appcast.xml` 並推送（Sparkle 從 main 分支讀取資料）。
- [ ] 從乾淨的暫存目錄（沒有 `package.json`）執行 `npx -y openclaw @X.Y.Z send --help` 以確認安裝/CLI 進入點正常運作。
- [ ] 發布/分享版本說明。

## 外掛程式發布範圍 (npm)

我們只在 `@openclaw/*` 範圍下發布**現有的 npm 外掛程式**。未在 npm 上的綑綁外掛程式僅保留在**磁碟目錄**（仍隨附於 `extensions/**`）。

衍生清單的程序：

1. `npm search @openclaw --json` 並擷取套件名稱。
2. 與 `extensions/*/package.json` 的名稱進行比較。
3. 僅發布**交集**部分（已在 npm 上的）。

目前 npm 外掛程式清單（依需求更新）：

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

版本說明還必須提到**非預設開啟的全新選用綑綁外掛程式**（例如：`tlon`）。
