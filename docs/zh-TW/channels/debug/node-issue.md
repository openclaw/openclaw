---
summary: Node + tsx "__name is not a function" crash notes and workarounds
read_when:
  - Debugging Node-only dev scripts or watch mode failures
  - Investigating tsx/esbuild loader crashes in OpenClaw
title: Node + tsx Crash
---

# Node + tsx "\_\_name is not a function" 崩潰問題

## Summary

透過 Node 執行 OpenClaw 時，`tsx` 在啟動時失敗，錯誤如下：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

這是在將開發腳本從 Bun 切換到 `tsx` 之後開始的（提交 `2871657e`，2026-01-06）。相同的執行時路徑在 Bun 上也能正常運作。

## Environment

- Node: v25.x（在 v25.3.0 上觀察到）
- tsx: 4.21.0
- OS: macOS（在其他執行 Node 25 的平台上也可能重現）

## Repro (僅限 Node)

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
- Node 24：尚未安裝；需要驗證

## 注意事項 / 假設

- `tsx` 使用 esbuild 來轉換 TS/ESM。esbuild 的 `keepNames` 會產生一個 `__name` 幫助函數，並用 `__name(...)` 包裝函數定義。
- 當前崩潰顯示 `__name` 存在但在執行時不是一個函數，這意味著該模組在 Node 25 載入路徑中缺少或被覆蓋了幫助函數。
- 在其他 esbuild 使用者中，當幫助函數缺失或被重寫時，類似的 `__name` 幫助函數問題也有被報告。

## 回歸歷史

- `2871657e` (2026-01-06): 腳本從 Bun 變更為 tsx，以使 Bun 成為可選項。
- 在那之前（Bun 路徑），`openclaw status` 和 `gateway:watch` 是可行的。

## Workarounds

- 使用 Bun 來執行開發腳本（目前暫時回退）。
- 使用 Node + tsc 監視，然後執行編譯後的輸出：

```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
```

- 確認在本地：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 在 Node 25 上運作正常。
- 如果可能，請在 TS 載入器中禁用 esbuild 的 keepNames（這會防止插入 `__name` 助手）；目前 tsx 並未公開此功能。
- 測試 Node LTS (22/24) 與 `tsx`，以查看問題是否特定於 Node 25。

## References

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 下一步

- 在 Node 22/24 上重現以確認 Node 25 的回歸問題。
- 測試 `tsx` 每晚版本，或如果已知存在回歸問題則固定到早期版本。
- 如果在 Node LTS 上重現，請上游提交一個最小重現範例，並附上 `__name` 堆疊追蹤。
