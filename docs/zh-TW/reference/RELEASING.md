---
summary: "npm + macOS 應用程式的逐步發佈檢查清單"
read_when:
  - 發佈新的 npm 版本
  - 發佈新的 macOS 應用程式版本
  - 從儲存庫根目錄使用 `pnpm`（Node 22+）。
---

# 「npm + macOS 應用程式的逐步發佈檢查清單」

在標記／發佈前保持工作樹乾淨。 Keep the working tree clean before tagging/publishing.

## 操作者觸發

當操作者說出「release」時，請立即執行以下預檢（除非被阻擋，否則不要提出額外問題）：

- 閱讀本文件與 `docs/platforms/mac/release.md`。
- 從 `~/.profile` 載入環境變數，並確認 `SPARKLE_PRIVATE_KEY_FILE` 與 App Store Connect 相關變數已設定（SPARKLE_PRIVATE_KEY_FILE 應位於 `~/.profile`）。
- 如有需要，使用來自 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 的 Sparkle 金鑰。

1. **版本與中繼資料**

- [ ] 提升 `package.json` 版本（例如：`2026.1.29`）。
- [ ] 執行 `pnpm plugins:sync` 以對齊擴充套件套件版本與變更記錄。
- [ ] 更新 CLI／版本字串：[`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 以及 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) 中的 Baileys 使用者代理。
- [ ] 確認套件中繼資料（name、description、repository、keywords、license），並確認 `bin` map 指向 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) 以供 `openclaw` 使用。
- [ ] 若相依套件有變更，請執行 `pnpm install`，以確保 `pnpm-lock.yaml` 為最新。

2. **建置與產出物**

- [ ] 若 A2UI 輸入有變更，請執行 `pnpm canvas:a2ui:bundle`，並提交任何更新後的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build`（會重新產生 `dist/`）。
- [ ] 驗證 npm 套件 `files` 是否包含所有必要的 `dist/*` 資料夾（特別是用於無頭 node 與 ACP CLI 的 `dist/node-host/**` 與 `dist/acp/**`）。
- [ ] 確認 `dist/build-info.json` 存在，且包含預期的 `commit` 雜湊（CLI 橫幅在 npm 安裝時會使用此值）。
- [ ] 選擇性：建置後執行 `npm pack --pack-destination /tmp`；檢查 tarball 內容，並保留以供 GitHub 發佈使用（**不要**提交該檔案）。

3. **變更記錄與文件**

- [ ] 使用面向使用者的重點更新 `CHANGELOG.md`（若檔案不存在請建立）；項目需嚴格依版本由新到舊排序。
- [ ] 確保 README 中的範例／旗標與目前 CLI 行為一致（特別是新指令或選項）。

4. **驗證**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（或需要覆蓋率輸出時使用 `pnpm test:coverage`）
- [ ] `pnpm release:check`（驗證 npm pack 內容）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker 安裝冒煙測試，快速路徑；發佈前必須執行）
  - 若已知前一個 npm 發佈版本損壞，請在 preinstall 步驟設定 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。
- [ ] （選擇性）完整安裝程式冒煙測試（加入非 root + CLI 覆蓋）：`pnpm test:install:smoke`
- [ ] （選擇性）安裝程式端對端測試（Docker，執行 `curl -fsSL https://openclaw.ai/install.sh | bash`、完成入門引導，然後執行實際工具呼叫）：
  - `pnpm test:install:e2e:openai`（需要 `OPENAI_API_KEY`）
  - `pnpm test:install:e2e:anthropic`（需要 `ANTHROPIC_API_KEY`）
  - `pnpm test:install:e2e`（需要兩把金鑰；會同時執行兩個提供者）
- [ ] （選擇性）若變更影響傳送／接收路徑，請抽查 Web Gateway 閘道器。

5. **macOS 應用程式（Sparkle）**

- [ ] Build + sign the macOS app, then zip it for distribution.
- [ ] 產生 Sparkle appcast（HTML 註解透過 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)），並更新 `appcast.xml`。
- [ ] 準備好要附加至 GitHub 發佈的應用程式 zip（以及選擇性的 dSYM zip）。
- [ ] Follow [macOS release](/platforms/mac/release) for the exact commands and required env vars.
  - `APP_BUILD` 必須是數值且單調遞增（不可使用 `-beta`），以便 Sparkle 正確比較版本。
  - **發佈（npm）**

6. **Publish (npm)**

- [ ] 確認 git 狀態為乾淨；視需要提交並推送。
- [ ] 如有需要，執行 `npm login`（驗證 2FA）。
- [ ] `npm publish --access public`（預先發佈版本請使用 `--tag beta`）。
- [ ] 驗證登錄表：`npm view openclaw version`、`npm view openclaw dist-tags` 與 `npx -y openclaw@X.Y.Z --version`（或 `--help`）。

### Troubleshooting (notes from 2.0.0-beta2 release)

- **npm pack／publish 卡住或產生巨大的 tarball**：`dist/OpenClaw.app` 中的 macOS 應用程式套件（以及發佈用 zip）被一併打包。請透過 `package.json` `files` 白名單化發佈內容（包含 dist 子目錄、文件、skills；排除應用程式套件）。使用 `npm pack --dry-run` 確認 `dist/OpenClaw.app` 未被列出。 Fix by whitelisting publish contents via `package.json` `files` (include dist subdirs, docs, skills; exclude app bundles). 公告／分享發佈說明。
- **npm auth web 在 dist-tags 進入循環**：使用舊版驗證以取得 OTP 提示：
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 驗證因 `ECOMPROMISED: Lock compromised` 失敗**：使用全新快取重試：
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **晚到的修正需要重新指向標籤**：強制更新並推送標籤，然後確保 GitHub 發佈資產仍相符：
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 發佈 + appcast**

- [ ] 建立標籤並推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（或 `git push --tags`）。
- [ ] 為 `vX.Y.Z` 建立／更新 GitHub 發佈，**標題使用 `openclaw X.Y.Z`**（不只是標籤）；內文需內嵌該版本的**完整**變更記錄區段（Highlights + Changes + Fixes），不可只放連結，且**不得在內文重複標題**。
- [ ] 附加產出物：`npm pack` tarball（選擇性）、`OpenClaw-X.Y.Z.zip`，以及（若有產生）`OpenClaw-X.Y.Z.dSYM.zip`。
- [ ] 提交更新後的 `appcast.xml` 並推送（Sparkle 會從 main 提要）。
- [ ] 從乾淨的暫存目錄（沒有 `package.json`）執行 `npx -y openclaw@X.Y.Z send --help`，以確認安裝／CLI 進入點可正常運作。
- [ ] Announce/share release notes.

## Plugin publish scope (npm)

我們只在 `@openclaw/*` 範圍下發佈**既有的 npm 外掛**。未上架 npm 的隨附
外掛僅維持為**磁碟樹**（仍會隨 `extensions/**` 一併出貨）。 Bundled
plugins that are not on npm stay **disk-tree only** (still shipped in
`extensions/**`).

推導清單的流程：

1. 執行 `npm search @openclaw --json` 並擷取套件名稱。
2. 與 `extensions/*/package.json` 名稱比對。
3. Publish only the **intersection** (already on npm).

目前的 npm 外掛清單（視需要更新）：

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

Release notes must also call out **new optional bundled plugins** that are **not
on by default** (example: `tlon`).
