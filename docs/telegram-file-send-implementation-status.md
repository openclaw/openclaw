# Telegram File Send Implementation Status

## 狀態總結
這次 Telegram file-send patch 已完成到「source patch + test pass + build success」階段，但尚未完成 source CLI 的 end-to-end `message send --dry-run` 驗證，原因是 source repo 本地執行時遇到獨立的 plugin loading 問題，而非 Telegram patch 本身錯誤。

## 已完成
### 1. Source patch
已在以下檔案補上 Telegram `sendMessage` 的 media alias mapping：
- `extensions/telegram/src/action-runtime.ts`

目前接受：
- `media`
- `mediaUrl`
- `filePath`
- `path`

### 2. Tests added
已在以下檔案新增最小測試：
- `extensions/telegram/src/action-runtime.test.ts`

新增測試案例：
- `filePath` alias -> `mediaUrl`
- `path` alias -> `mediaUrl`
- `asDocument` -> `forceDocument`

### 3. Test result
已成功執行：
- `pnpm test extensions/telegram/src/action-runtime.test.ts`

結果：
- 1 test file passed
- 53 tests passed
- 0 failures

### 4. Build result
已成功執行：
- `pnpm build`

結果：
- build 完成
- exit code 0

## Source repo commits
1. `4ab61cd` — `telegram: accept filePath/path aliases in sendMessage action`
2. `9504d6e` — `telegram: add sendMessage filePath/path alias tests`
3. `accb581` — `docs: add Telegram file send PR summary`

## 尚未完成
### End-to-end source CLI dry-run
嘗試執行：
- `node openclaw.mjs message send --channel telegram --target <telegramChatId> --media ./README.md --force-document --reply-to <messageId> --dry-run --json`

但 source CLI 在 plugin registry 載入階段失敗，錯誤為：
- `Multiple matrix-js-sdk entrypoints detected!`

## 重要判讀
- 這不是 Telegram patch 本身導致的錯誤。
- 這是 source repo 本地 CLI/plugin loading / shared bundle 環境的獨立問題。
- 進一步追查顯示：Telegram plugin 與其常用 `plugin-sdk/*` shared imports 單獨載入都正常；真正可疑的是 CLI 啟動時載入的共用 dist chunk（特別是 `dist/auth-profiles-*.js`）已直接打包 Matrix SDK 相關內容，導致 source CLI dry-run 在更上層 runtime 路徑就踩到 `matrix-js-sdk` entrypoint 問題。
- 因此，Telegram file-send patch 本身目前可視為：
  - source 已改
  - 測試已補
  - 單元測試已通過
  - build 已成功

## 建議下一步
### 若要繼續推進 Telegram patch
目前已足夠做工程 handoff / PR。

### 若要做更完整驗證
下一步應處理 source repo 的 plugin loading 問題，之後再重跑：
- `message send --dry-run`
- 實際 Telegram smoke test

## 一句話版本
**這次 Telegram file-send patch 已完成到可 PR / 可 handoff 階段；目前卡住的是 source CLI 本地 plugin loading 問題，不是 patch 本身。**
