---
title: CI 管線
description: OpenClaw CI 管線的運作方式
---

# CI 管線

CI 會在每次推送到 `main` 分支以及每次 pull request 時執行。它使用智慧範圍界定 (smart scoping) 來略過僅變更文件或原生程式碼時的高昂作業。

## 作業概覽

| 作業 (Job)        | 目的                                | 執行時機             |
| ----------------- | ----------------------------------- | -------------------- |
| `docs-scope`      | 偵測僅文件的變更                    | 總是                 |
| `changed-scope`   | 偵測變更的區域 (node/macos/android) | 非文件的 PR          |
| `check`           | TypeScript 型別、lint、格式化       | 非文件的變更         |
| `check-docs`      | Markdown lint + 損壞連結檢查        | 文件變更時           |
| `code-analysis`   | 程式碼行數 (LOC) 閾值檢查 (1000 行) | 僅限 PR              |
| `secrets`         | 偵測外洩的密鑰 (secrets)            | 總是                 |
| `build-artifacts` | 建置一次 dist 並分享給其他作業      | 非文件、node 變更    |
| `release-check`   | 驗證 npm pack 內容                  | 建置後               |
| `checks`          | Node/Bun 測試 + 協定檢查            | 非文件、node 變更    |
| `checks-windows`  | Windows 專屬測試                    | 非文件、node 變更    |
| `macos`           | Swift lint/建置/測試 + TS 測試      | 包含 macos 變更的 PR |
| `android`         | Gradle 建置 + 測試                  | 非文件、android 變更 |

## 快速失敗 (Fail-Fast) 順序

作業已排序，以便在執行高昂檢查之前，先讓低成本的檢查失敗：

1. `docs-scope` + `code-analysis` + `check` (並行，約 1-2 分鐘)
2. `build-artifacts` (相依於上述作業)
3. `checks`、`checks-windows`、`macos`、`android` (相依於建置作業)

## 執行器 (Runners)

| 執行器 (Runner)                 | 作業 (Jobs)       |
| ------------------------------- | ----------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | 大多數 Linux 作業 |
| `blacksmith-4vcpu-windows-2025` | `checks-windows`  |
| `macos-latest`                  | `macos`, `ios`    |
| `ubuntu-latest`                 | 範圍偵測 (輕量級) |

## 本地對應指令

```bash
pnpm check          # 型別 + lint + 格式化
pnpm test           # vitest 測試
pnpm check:docs     # 文件格式化 + lint + 損壞連結
pnpm release:check  # 驗證 npm pack
```
