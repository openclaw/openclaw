---
title: CI Pipeline
description: How the OpenClaw CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

CI 在每次推送到 `main` 和每個拉取請求時執行。它使用智能範圍來跳過當只有文檔或原生程式碼更改時的昂貴工作。

## 工作概述

| 工作              | 目的                                               | 執行時間                               |
| ----------------- | -------------------------------------------------- | -------------------------------------- |
| `docs-scope`      | 偵測僅文件變更                                     | 始終執行                               |
| `changed-scope`   | 偵測哪些區域發生變更（node/macos/android/windows） | 非文件的 PR                            |
| `check`           | TypeScript 類型、lint、格式化                      | 推送到 `main`，或有 Node 相關變更的 PR |
| `check-docs`      | Markdown lint + 斷鏈檢查                           | 文件變更                               |
| `code-analysis`   | LOC 閾值檢查（1000 行）                            | 僅限 PR                                |
| `secrets`         | 偵測洩漏的秘密                                     | 始終執行                               |
| `build-artifacts` | 建置 dist 一次，與其他工作共享                     | 非文件、node 變更                      |
| `release-check`   | 驗證 npm 打包內容                                  | 建置後                                 |
| `checks`          | Node/Bun 測試 + 協議檢查                           | 非文件、node 變更                      |
| `checks-windows`  | Windows 特定測試                                   | 非文件、與 Windows 相關的變更          |
| `macos`           | Swift lint/build/test + TS 測試                    | 有 macos 變更的 PR                     |
| `android`         | Gradle 建置 + 測試                                 | 非文件、android 變更                   |

## Fail-Fast Order

工作是按順序執行的，因此便宜的檢查會在昂貴的檢查執行之前失敗：

1. `docs-scope` + `code-analysis` + `check` (平行處理，約 1-2 分鐘)
2. `build-artifacts` (受上述影響)
3. `checks`, `checks-windows`, `macos`, `android` (受建置影響)

範圍邏輯位於 `scripts/ci-changed-scope.mjs`，並在 `src/scripts/ci-changed-scope.test.ts` 中由單元測試覆蓋。

## Runners

| Runner                           | Jobs                            |
| -------------------------------- | ------------------------------- |
| `blacksmith-16vcpu-ubuntu-2404`  | 大部分 Linux 工作，包括範圍檢測 |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                |
| `macos-latest`                   | `macos`, `ios`                  |

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
