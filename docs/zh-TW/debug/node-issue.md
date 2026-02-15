---
summary: Node + tsx 「__name is not a function」崩潰筆記與解決方案
read_when:
  - 偵錯僅限 Node 的開發指令碼或監控模式 (watch mode) 失敗時
  - 調查 OpenClaw 中的 tsx/esbuild 載入器崩潰時
title: "Node + tsx 崩潰"
---

# Node + tsx 「\_\_name is not a function」崩潰

## 摘要

使用 tsx 透過 Node 執行 OpenClaw 時，啟動失敗並出現以下錯誤：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

此問題始於將開發指令碼從 Bun 切換為 tsx 之後（提交 `2871657e`，2026-01-06）。同樣的執行路徑在 Bun 中可以正常運作。

## 環境

- Node: v25.x（觀察到版本 v25.3.0）
- tsx: 4.21.0
- 作業系統: macOS（在其他執行 Node 25 的平台上也可能重現）

## 重現步驟（僅限 Node）

```bash
# 在儲存庫根目錄
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 儲存庫中的最小重現

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本檢查

- Node 25.3.0: 失敗
- Node 22.22.0 (Homebrew `node @22`): 失敗
- Node 24: 尚未在此處安裝；需要驗證

## 筆記 / 假設

- `tsx` 使用 esbuild 來轉換 TS/ESM。esbuild 的 `keepNames` 會產生一個 `__name` 輔助程式，並用 `__name(...)` 包裝函式定義。
- 崩潰顯示 `__name` 存在，但在執行時不是一個函式，這意味著在 Node 25 的載入器路徑中，該模組的輔助程式遺失或被覆蓋。
- 在其他使用 esbuild 的工具中，當輔助程式遺失或被重寫時，也曾回報過類似的 `__name` 輔助程式問題。

## 迴歸歷史

- `2871657e` (2026-01-06): 指令碼從 Bun 更改為 tsx 以使 Bun 成為選配。
- 在此之前（Bun 路徑），`openclaw status` 和 `gateway:watch` 均可運作。

## 解決方案

- 開發指令碼使用 Bun（目前暫時還原）。
- 使用 Node + tsc watch，然後執行編譯後的輸出：

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 已在本地確認：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 在 Node 25 上可以正常運作。
- 如果可能，在 TS 載入器中停用 esbuild `keepNames`（防止插入 `__name` 輔助程式）；tsx 目前未提供此設定。
- 使用 tsx 測試 Node LTS (22/24)，查看問題是否僅限於 Node 25。

## 參考資料

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 後續步驟

- 在 Node 22/24 上重現以確認 Node 25 的迴歸問題。
- 如果存在已知的迴歸問題，請測試 tsx nightly 或固定在較早的版本。
- 如果在 Node LTS 上重現，請向上游提交包含 `__name` 堆疊追蹤的最小重現範例。
