---
summary: Node + tsx「__name is not a function」當機的筆記與替代方案
read_when:
  - 除錯僅限 Node 的開發腳本或 watch 模式失敗
  - 調查 OpenClaw 中的 tsx/esbuild 載入器當機
title: "Node + tsx 當機"
---

# Node + tsx "\_\_name is not a function" 當機

## 摘要

透過 Node 執行 OpenClaw 並搭配 `tsx`，在啟動時會失敗，並顯示：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

This began after switching dev scripts from Bun to `tsx` (commit `2871657e`, 2026-01-06). The same runtime path worked with Bun.

## 環境

- Node：v25.x（於 v25.3.0 觀察到）
- tsx：4.21.0
- OS：macOS（在其他可執行 Node 25 的平台上也可能重現）

## 重現（僅 Node）

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本檢查

- Node 25.3.0：失敗
- Node 22.22.0（Homebrew `node@22`）：失敗
- Node 24：此處尚未安裝；需要驗證

## 注意事項／假設

- `tsx` 使用 esbuild 來轉換 TS/ESM。esbuild 的 `keepNames` 會產生一個 `__name` 輔助函式，並以 `__name(...)` 包裝函式定義。 esbuild’s `keepNames` emits a `__name` helper and wraps function definitions with `__name(...)`.
- 當機顯示 `__name` 在執行期存在但不是函式，這表示在 Node 25 的載入器路徑中，該輔助函式在此模組中遺失或被覆寫。
- 在其他 esbuild 使用者中，當輔助函式遺失或被重寫時，也曾回報過類似的 `__name` 輔助函式問題。

## 回歸歷史

- `2871657e`（2026-01-06）：為了讓 Bun 成為選配，腳本從 Bun 改為 tsx。
- 在此之前（Bun 路徑），`openclaw status` 與 `gateway:watch` 可正常運作。

## Workarounds

- 在開發腳本中使用 Bun（目前的暫時性回退）。

- 使用 Node + tsc watch，然後執行已編譯的輸出：

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 本機已確認：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 可在 Node 25 上運作。

- 若可行，停用 TS 載入器中的 esbuild keepNames（可避免插入 `__name` 輔助函式）；tsx 目前未提供此選項。

- 以 `tsx` 測試 Node LTS（22/24），以確認是否為 Node 25 專屬問題。

## 參考資料

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 後續步驟

- 在 Node 22/24 上重現以確認是否為 Node 25 的回歸問題。
- 測試 `tsx` nightly，或在確認存在已知回歸時固定到較早版本。
- 若在 Node LTS 上也可重現，請以上游提交最小重現，並附上 `__name` 的堆疊追蹤。
