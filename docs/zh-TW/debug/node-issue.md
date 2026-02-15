---
summary: Node + tsx 「__name is not a function」當機筆記與解決方法
read_when:
  - 偵錯僅限 Node 的開發指令碼或監看模式失敗
  - 調查 OpenClaw 中 tsx/esbuild loader 當機問題
title: "Node + tsx 當機"
---

# Node + tsx 「__name is not a function」當機

## 摘要

透過 `tsx` 執行 Node 的 OpenClaw 在啟動時會失敗並顯示：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

這是在將開發指令碼從 Bun 切換到 `tsx` 後開始的（提交 `2871657e`，2026-01-06）。相同的執行路徑在 Bun 下是正常運作的。

## 環境

- Node: v25.x (在 v25.3.0 上觀察到)
- tsx: 4.21.0
- OS: macOS (在執行 Node 25 的其他平台上也可能重現)

## 重現步驟（僅限 Node）

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 儲存庫中的最小重現步驟

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本檢查

- Node 25.3.0: 失敗
- Node 22.22.0 (Homebrew `node @22`): 失敗
- Node 24: 尚未安裝；需要驗證

## 筆記 / 假設

- `tsx` 使用 esbuild 轉換 TS/ESM。esbuild 的 `keepNames` 會發出一個 `__name` 輔助程式，並用 `__name(...)` 包裝函式定義。
- 當機表示 `__name` 存在但在執行時期不是一個函式，這意味著在 Node 25 載入路徑中，此模組的輔助程式遺失或被覆寫。
- 其他 esbuild 消費者也報告過類似的 `__name` 輔助程式問題，當輔助程式遺失或被重寫時。

## 回歸歷史

- `2871657e` (2026-01-06): 指令碼從 Bun 變更為 tsx，以使 Bun 成為可選項目。
- 在此之前（Bun 路徑），`openclaw status` 和 `gateway:watch` 正常運作。

## 解決方法

- 將 Bun 用於開發指令碼（目前暫時復原）。
- 使用 Node + tsc 監看，然後執行編譯後的輸出：

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 經本地確認：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 在 Node 25 上正常運作。
- 如果可能，在 TS 載入器中停用 esbuild `keepNames`（防止插入 `__name` 輔助程式）；tsx 目前不支援此功能。
- 使用 `tsx` 測試 Node LTS (22/24) 以查看此問題是否僅限於 Node 25。

## 參考資料

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 後續步驟

- 在 Node 22/24 上重現以確認是否為 Node 25 的回歸問題。
- 如果存在已知回歸，則測試 `tsx` 每晚建構版本或鎖定到較早版本。
- 如果在 Node LTS 上重現，則向上游提交一個帶有 `__name` 堆疊追蹤的最小重現案例。
