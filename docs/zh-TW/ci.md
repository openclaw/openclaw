---
title: CI/CD 管線
description: OpenClaw CI/CD 管線的運作方式
---

# CI/CD 管線

CI/CD 會在每次推送到 `main` 分支和每個合併請求時執行。它使用智慧範圍界定來跳過耗時的任務，當只有文件或原生程式碼變更時。

## 任務概覽

| 任務               | 目的                                         | 執行時機              |
| ----------------- | ----------------------------------------------- | ------------------------- |
| `docs-scope`      | 偵測僅文件變更                        | 總是                    |
| `changed-scope`   | 偵測哪些區域已變更 (node/macos/android) | 非文件相關的合併請求              |
| `check`           | TypeScript 類型、Lint、格式化                  | 非文件相關的變更          |
| `check-docs`      | Markdown Lint + 斷鏈檢查               | 文件已變更              |
| `code-analysis`   | 程式碼行數閾值檢查 (1000 行)                | 僅合併請求                  |
| `secrets`         | 偵測洩漏的秘密                           | 總是                    |
| `build-artifacts` | 僅建構一次 dist，並與其他任務共用          | 非文件、node 變更    |
| `release-check`   | 驗證 npm pack 內容                      | 建構後               |
| `checks`          | Node/Bun 測試 + 協定檢查                 | 非文件、node 變更    |
| `checks-windows`  | Windows 專用測試                          | 非文件、node 變更    |
| `macos`           | Swift Lint/建構/測試 + TS 測試                | macOS 變更相關的合併請求    |
| `android`         | Gradle 建構 + 測試                            | 非文件、Android 變更 |

## 快速失敗順序

任務的排序方式是讓低成本的檢查失敗先於高成本的檢查執行：

1. `docs-scope` + `code-analysis` + `check` (並行，約 1-2 分鐘)
2. `build-artifacts` (阻擋於上方任務)
3. `checks`, `checks-windows`, `macos`, `android` (阻擋於建構)

## 執行器

| 執行器                          | 任務                          |
| ------------------------------- | ----------------------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | 大多數 Linux 任務               |
| `blacksmith-4vcpu-windows-2025` | `checks-windows`              |
| `macos-latest`                  | `macos`, `ios`                |
| `ubuntu-latest`                 | 範圍偵測 (輕量) |

## 本機對應指令

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
