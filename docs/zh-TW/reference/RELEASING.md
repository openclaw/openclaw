---
title: "發布檢查清單"
summary: "npm + macOS 應用程式的逐步發布檢查清單"
read_when:
  - 進行新的 npm 發布
  - 進行新的 macOS 應用程式發布
  - 在發布前驗證中繼資料
---

# 發布檢查清單 (npm + macOS)

在專案根目錄使用 `pnpm` (Node 22+)。在標記/發布之前，保持工作樹清潔。

## 操作員觸發

當操作員說「發布」時，請立即執行此預檢 (除非受阻，否則無需額外提問)：

- 閱讀此文件和 `docs/platforms/mac/release.md`。
- 從 `~/.profile` 載入環境變數並確認 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 環境變數已設定 (SPARKLE_PRIVATE_KEY_FILE 應位於 `~/.profile`)。
- 如有需要，使用 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 中的 Sparkle 鍵。

1. **版本與中繼資料**

- [ ] 更新 `package.json` 版本 (例如 `2026.1.29`)。
- [ ] 執行 `pnpm plugins:sync` 以對齊擴充套件包版本 + 變更日誌。
- [ ] 更新 CLI/版本字串：[`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 和 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) 中的 Baileys 使用者代理。
- [ ] 確認包中繼資料 (名稱、描述、儲存庫、關鍵字、許可證) 以及 `bin` 對應至 `openclaw` 的 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)。
- [ ] 如果依賴項已更改，請執行 `pnpm install` 以使 `pnpm-lock.yaml` 為最新。

2. **建置與構件**

- [ ] 如果 A2UI 輸入已更改，請執行 `pnpm canvas:a2ui:bundle` 並提交任何更新的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build` (重新生成 `dist/`)。
- [ ] 驗證 npm 包的 `files` 包含所有必需的 `dist/*` 資料夾 (特別是無頭節點 + ACP CLI 的 `dist/node-host/**` 和 `dist/acp/**`)。
- [ ] 確認 `dist/build-info.json` 存在並包含預期的 `commit` 雜湊 (CLI 橫幅用於 npm 安裝)。
- [ ] 選填：建置後執行 `npm pack --pack-destination /tmp`；檢查 tarball 內容並將其保留以供 GitHub 發布 (請勿提交)。

3. **變更日誌與文件**

- [ ] 使用面向使用者的重點更新 `CHANGELOG.md` (如果缺少則建立檔案)；保持條目嚴格按版本遞減。
- [ ] 確保 README 範例/旗標與當前的 CLI 行為匹配 (特別是新命令或選項)。

4. **驗證**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (如果需要覆蓋率輸出，則為 `pnpm test:coverage`)
- [ ] `pnpm release:check` (驗證 npm 包內容)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker 安裝完整性檢查，快速路徑；發布前必需)
  - 如果已知前一個 npm 發布已損壞，請為預安裝步驟設定 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。
- [ ] (選填) 完整安裝程式完整性檢查 (新增非根 + CLI 覆蓋率)：`pnpm test:install:smoke`
- [ ] (選填) 安裝程式 E2E (Docker，執行 `curl -fsSL https://openclaw.ai/install.sh | bash`，然後進行新手導覽，接著執行實際的工具呼叫)：
  - `pnpm test:install:e2e:openai` (需要 `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (需要 `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (需要兩個金鑰；執行兩個供應商)
- [ ] (選填) 如果您的更改影響傳送/接收路徑，請抽查網頁 Gateway。

5. **macOS 應用程式 (Sparkle)**

- [ ] 建置 + 簽署 macOS 應用程式，然後壓縮以供分發。
- [ ] 生成 Sparkle appcast (透過 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 的 HTML 說明) 並更新 `appcast.xml`。
- [ ] 準備好應用程式壓縮檔 (和選填的 dSYM 壓縮檔) 以附加到 GitHub 發布。
- [ ] 遵循 [macOS release](/platforms/mac/release) 以獲取確切命令和所需環境變數。
  - `APP_BUILD` 必須是數字 + 單調遞增 (無 `-beta`)，以便 Sparkle 正確比較版本。
  - 如果進行公證，請使用從 App Store Connect API 環境變數建立的 `openclaw-notary` 鑰匙圈設定檔 (請參閱 [macOS release](/platforms/mac/release))。

6. **發布 (npm)**

- [ ] 確認 git 狀態乾淨；視需要提交並推送。
- [ ] 如有需要，`npm login` (驗證雙因素驗證)。
- [ ] `npm publish --access public` (預發布使用 `--tag beta`)。
- [ ] 驗證註冊表：`npm view openclaw version`、`npm view openclaw dist-tags` 和 `npx -y openclaw @X.Y.Z --version` (或 `--help`)。

### 疑難排解 (來自 2.0.0-beta2 發布的筆記)

- **npm pack/publish 卡住或產生巨大的 tarball**：`dist/OpenClaw.app` 中的 macOS 應用程式套件 (和發布壓縮檔) 會被掃入包中。透過 `package.json` `files` 白名單發布內容來解決 (包含 dist 子目錄、文件、Skills；排除應用程式套件)。使用 `npm pack --dry-run` 確認 `dist/OpenClaw.app` 未列出。
- **npm auth 網頁循環用於 dist-tags**：使用傳統憑證以獲取 OTP 提示：
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw @X.Y.Z latest`
- **`npx` 驗證失敗並顯示 `ECOMPROMISED: Lock compromised`**：使用新的快取重試：
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw @X.Y.Z --version`
- **後期修正後需要重新指向標籤**：強制更新並推送標籤，然後確保 GitHub 發布資產仍然匹配：
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 發布 + appcast**

- [ ] 標記並推送：`git tag vX.Y.Z && git push origin vX.Y.Z` (或 `git push --tags`)。
- [ ] 為 `vX.Y.Z` 建立/重新整理 GitHub 發布，**標題為 `openclaw X.Y.Z`** (不只是標籤)；內容應包含該版本的**完整**變更日誌區塊 (重點 + 變更 + 修正)，內聯 (無裸連結)，且**不得在內容中重複標題**。
- [ ] 附加構件：`npm pack` tarball (選填)、`OpenClaw-X.Y.Z.zip` 和 `OpenClaw-X.Y.Z.dSYM.zip` (如果已生成)。
- [ ] 提交更新的 `appcast.xml` 並推送 (Sparkle 從 main 獲取資料)。
- [ ] 從一個乾淨的臨時目錄 (無 `package.json`)，執行 `npx -y openclaw @X.Y.Z send --help` 以確認安裝/CLI 進入點正常運作。
- [ ] 公告/分享發布說明。

## 外掛發布範圍 (npm)

我們僅在 ` @openclaw/*` 範圍下發布**現有的 npm 外掛**。未在 npm 上的捆綁外掛保留**僅限磁碟樹** (仍透過 `extensions/**` 運送)。

推導列表的程式：

1. `npm search @openclaw --json` 並擷取包名稱。
2. 與 `extensions/*/package.json` 名稱進行比較。
3. 僅發布**交集** (已在 npm 上)。

目前的 npm 外掛列表 (視需要更新)：

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

發布說明還必須指出**新的可選捆綁外掛**，這些外掛**預設不啟用** (範例：`tlon`)。
