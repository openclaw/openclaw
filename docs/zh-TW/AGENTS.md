# 倉庫規範 (Repository Guidelines)

- 倉庫：https://github.com/openclaw/openclaw
- GitHub issues/評論/PR 評論：使用字面多行字串或 `-F - <<'EOF'` (或 $'...') 處理真實換行；切勿嵌入 "\\n"。

## 專案結構與模組組織

- 原始碼：`src/` (CLI 串接於 `src/cli`，指令於 `src/commands`，Web 供應商於 `src/provider-web.ts`，基礎設施於 `src/infra`，多媒體管線於 `src/media`)。
- 測試：同目錄下的 `*.test.ts`。
- 文件：`docs/` (圖片、佇列、Pi 設定)。編譯後的輸出位於 `dist/`。
- 插件/擴充：位於 `extensions/*` (工作區套件)。插件專用的依賴項請保留在該插件的 `package.json` 中；除非核心程式碼有使用，否則請勿將其加入根目錄的 `package.json`。
- 插件：安裝時在插件目錄運行 `npm install --omit=dev`；執行時依賴必須放在 `dependencies`。避免在 `dependencies` 中使用 `workspace:*` (npm install 會失敗)；請將 `openclaw` 放入 `devDependencies` 或 `peerDependencies` (執行時會透過 jiti 別名解析 `openclaw/plugin-sdk`)。
- 從 `https://openclaw.ai/*` 提供的安裝程式：位於兄弟倉庫 `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`)。
- 通訊頻道：在重構共享邏輯（路由、白名單、配對、指令門控、上線引導、文件）時，務必考慮 **所有** 內建與擴充頻道。
  - 核心頻道文件：`docs/channels/`
  - 核心頻道代碼：`src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`
  - 擴充頻道 (插件)：`extensions/*` (例如 `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- 當新增頻道/擴充/應用/文件時，請更新 `.github/labeler.yml` 並建立對應的 GitHub 標籤 (使用現有的頻道/擴充標籤顏色)。

## 文件連結 (Mintlify)

- 文件託管於 Mintlify (docs.openclaw.ai)。
- `docs/**/*.md` 內部的連結：使用根目錄相對路徑，不含 `.md`/`.mdx` (例如：`[設定](/configuration)`)。
- 處理文件時，請參閱 mintlify skill。
- 區段交叉引用：在根目錄相對路徑上使用錨點 (例如：`[掛鉤](/configuration#hooks)`)。
- 文件標題與錨點：避免在標題中使用長破折號 (em dashes) 與單引號，因為它們會破壞 Mintlify 的錨點連結。
- 當 Peter 詢問連結時，請回覆完整的 `https://docs.openclaw.ai/...` URL (而非相對路徑)。
- 當你更動文件時，請在回覆結尾附上你所引用的 `https://docs.openclaw.ai/...` URL。
- README (GitHub)：保持絕對文件 URL (`https://docs.openclaw.ai/...`) 以確保在 GitHub 上連結正常。
- 文件內容必須通用化：不可包含個人設備名稱/主機名/路徑；使用預位符如 `user@gateway-host` 和「gateway host」。

## 文件國際化 (zh-CN)

- `docs/zh-CN/**` 是自動生成的；除非使用者明確要求，否則請勿編輯。
- 管線：更新英文文件 → 調整術語表 (`docs/.i18n/glossary.zh-CN.json`) → 運行 `scripts/docs-i18n` → 僅在指示下套用特定修正。
- 翻譯記憶：`docs/.i18n/zh-CN.tm.jsonl` (生成的)。
- 參閱 `docs/.i18n/README.md`。

## exe.dev VM 操作 (一般)

- 存取：穩定路徑為 `ssh exe.dev` 隨後 `ssh vm-name` (假設 SSH 金鑰已設定)。
- SSH 不穩時：使用 exe.dev Web 終端機或 Shelley (Web Agent)；長時間操作請使用 tmux 會話。
- 更新：`sudo npm i -g openclaw@latest` (全域安裝需要 `/usr/lib/node_modules` 的 root 權限)。
- 設定：使用 `openclaw config set ...`；確保已設定 `gateway.mode=local`。
- Discord：僅存儲原始權杖 (不要有 `DISCORD_BOT_TOKEN=` 前綴)。
- 重啟：停止舊的 Gateway 並運行：
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- 驗證：`openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`。

## 建置、測試與開發指令

- 執行環境基線：Node **22+** (保持 Node 與 Bun 路徑正常)。
- 安裝依賴：`pnpm install`
- 如果缺少依賴 (例如 `node_modules` 遺失、`vitest` 找不到或指令找不到)，請運行倉庫對應的套件管理員安裝指令，然後重新運行一次請求的指令。
- Pre-commit hooks: `prek install` (運行與 CI 相同的檢查)。
- 同步支援：`bun install` (更動依賴時請保持 `pnpm-lock.yaml` 與 Bun patching 同步)。
- 執行 TypeScript (腳本、開發、測試) 時偏好使用 Bun：`bun <file.ts>` / `bunx <tool>`。
- 在開發環境運行 CLI：`pnpm openclaw ...` (bun) 或 `pnpm dev`。
- Node 仍支援運行編譯後的輸出 (`dist/*`) 與生產環境安裝。
- Mac 封裝 (開發)：`scripts/package-mac-app.sh` 預設為目前架構。發佈檢核清單：`docs/platforms/mac/release.md`。
- 型別檢查/建置：`pnpm build`
- TypeScript 檢查：`pnpm tsgo`
- Lint/格式化：`pnpm check`
- 格式化檢查：`pnpm format` (oxfmt --check)
- 格式化修正：`pnpm format:fix` (oxfmt --write)
- 測試：`pnpm test` (vitest)；覆蓋率：`pnpm test:coverage`

## 編碼風格與命名規範

- 語言：TypeScript (ESM)。偏好強型別；避免使用 `any`。
- 透過 Oxlint 與 Oxfmt 進行格式化與程式碼檢查；提交前請運行 `pnpm check`。
- 絕不添加 `@ts-nocheck`，也不要停用 `no-explicit-any`；修復根本原因，僅在必要時更新 Oxlint/Oxfmt 設定。
- 絕不透過原型變異 (prototype mutation) 共享類別行為。使用明確的繼承/組合或輔助函式組合，以便 TypeScript 進行型別檢查。
- 程式碼註釋：為複雜或不明顯的邏輯添加簡短註解。
- 保持檔案精簡；提取輔助函式而非建立「V2」複本。使用現有的 CLI 選項模式與依賴注入 (透過 `createDefaultDeps`)。
- 命名：產品/App/文件標題使用 **OpenClaw**；CLI 指令、套件/二進位檔、路徑與設定鍵名使用 `openclaw`。

## 發佈頻道 (命名)

- stable: 僅限已標記的發佈版 (例如 `vYYYY.M.D`)，npm dist-tag 為 `latest`。
- beta: 預發佈標記 `vYYYY.M.D-beta.N`，npm dist-tag 為 `beta`。
- dev: `main` 分支的最新動態。

## 測試規範

- 框架：Vitest 搭配 V8 覆蓋率門檻 (70%)。
- 命名：原始碼檔案對應 `*.test.ts`；E2E 測試為 `*.e2e.test.ts`。
- 實機測試 (使用真實金鑰)：`CLAWDBOT_LIVE_TEST=1 pnpm test:live` 或 `LIVE=1 pnpm test:live`。
- 變更日誌 (Changelog)：僅記錄面向使用者的變更。純測試的增加/修正通常不需要變更日誌分錄。

## 提交與 Pull Request 規範

- 使用 `scripts/committer "<msg>" <file...>` 建立提交；避免手動 `git add`/`git commit` 以保持暫存區範圍正確。
- 遵循簡潔、行動導向的提交訊息 (例如：`CLI: add verbose flag to send`)。
- 將相關變更分組；避免捆綁無關的重構。

## 安全性與設定小貼士

- Web 供應商憑證存儲於 `~/.openclaw/credentials/`。
- Pi 會話預設位於 `~/.openclaw/sessions/`。
- 絕不提交或發佈真實電話號碼、影片或即時配置值。在文件、測試與範例中使用明顯的虛假預位符。
- 發佈流程：在進行任何發佈工作前，務必閱讀 `docs/reference/RELEASING.md` 與 `docs/platforms/mac/release.md`。

## 故障排除

- 重新品牌/遷移問題或舊版設定警告：運行 `openclaw doctor`。

## Agent 專屬筆記

- 當在倉庫中新增 `AGENTS.md` 時，請同時新增一個指向它的 `CLAUDE.md` 符號連結。
- 在 GitHub Issue 或 PR 上工作時，請在任務結尾列印完整 URL。
- 回答問題時，僅提供高置信度的答案：在程式碼中驗證，不要猜測。
- CLI 進度：使用 `src/cli/progress.ts`；不要手動製作進度條。
- 狀態輸出：保持表格 + ANSI 安全換行 (`src/terminal/table.ts`)。
- **多 Agent 安全性**：除非明確要求，否則 **不要** 建立/套用/捨棄 `git stash` 分錄。假設其他 Agent 可能也在工作中；保持無關的 WIP 不受干擾。
- **多 Agent 安全性**：當使用者說 "push" 時，你可以使用 `git pull --rebase` 來整合最新變更 (絕不捨棄其他 Agent 的工作)。當使用者說 "commit" 時，範圍僅限於你的變更。
- 錯誤調查：在得出結論前，閱讀相關 npm 依賴項的原始碼與所有相關的本地代碼；目標是找出高置信度的根本原因。
- 型別定義：為複雜邏輯添加簡短註釋；盡可能保持檔案在 500 行以下 (必要時進行拆分/重構)。
