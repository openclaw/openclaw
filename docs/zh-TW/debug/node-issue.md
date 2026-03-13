---
summary: Node + tsx "__name is not a function" crash notes and workarounds
read_when:
  - Debugging Node-only dev scripts or watch mode failures
  - Investigating tsx/esbuild loader crashes in OpenClaw
title: Node + tsx Crash
---

# Node + tsx "\_\_name 不是函式" 崩潰

## 摘要

使用 Node 執行 OpenClaw 搭配 `tsx`，啟動時失敗並出現：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

此問題始於將開發腳本從 Bun 切換到 `tsx`（commit `2871657e`，2026-01-06）。相同的執行路徑在 Bun 下是正常的。

## 環境

- Node：v25.x（觀察於 v25.3.0）
- tsx：4.21.0
- 作業系統：macOS（在其他可執行 Node 25 的平台上也可能重現）

## 重現步驟（僅限 Node）

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 倉庫中的最小重現範例

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本檢查

- Node 25.3.0：失敗
- Node 22.22.0（Homebrew `node@22`）：失敗
- Node 24：尚未安裝，需進一步驗證

## 備註 / 假設

- `tsx` 使用 esbuild 轉譯 TS/ESM。esbuild 的 `keepNames` 會輸出一個 `__name` 輔助函式，並用 `__name(...)` 包裹函式定義。
- 崩潰訊息顯示 `__name` 在執行時存在但不是函式，這表示該輔助函式在 Node 25 的 loader 路徑中缺失或被覆寫。
- 其他使用 esbuild 的案例也曾報告過類似 `__name` 輔助函式缺失或被重寫導致的問題。

## 回歸歷史

- `2871657e` (2026-01-06)：將腳本從 Bun 改為 tsx，使 Bun 成為可選項。
- 在此之前（Bun 路徑），`openclaw status` 和 `gateway:watch` 都能正常運作。

## 解決方法

- 開發腳本使用 Bun（目前的臨時回退方案）。
- 使用 Node + tsc watch，然後執行編譯後的輸出：

```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
```

- 本地已確認：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 在 Node 25 上可用。
- 如果可能，禁用 TS loader 中 esbuild 的 keepNames（可防止插入 `__name` 助手）；tsx 目前尚未提供此選項。
- 使用 `tsx` 測試 Node LTS（22/24），確認問題是否僅限於 Node 25。

## 參考資料

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 下一步

- 在 Node 22/24 上重現問題，以確認是否為 Node 25 的回歸。
- 測試 `tsx` 夜間版本，或如果已知有回歸，則鎖定至較早版本。
- 若在 Node LTS 上重現，則帶著 `__name` 堆疊追蹤向上游提交最小重現範例。
