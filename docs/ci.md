---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: CI Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: How the OpenClaw CI pipeline works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# CI Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only docs or native code changed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Job Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Job               | Purpose                                         | When it runs              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ----------------------------------------------- | ------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `docs-scope`      | Detect docs-only changes                        | Always                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `changed-scope`   | Detect which areas changed (node/macos/android) | Non-docs PRs              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `check`           | TypeScript types, lint, format                  | Non-docs changes          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `check-docs`      | Markdown lint + broken link check               | Docs changed              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `code-analysis`   | LOC threshold check (1000 lines)                | PRs only                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `secrets`         | Detect leaked secrets                           | Always                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `build-artifacts` | Build dist once, share with other jobs          | Non-docs, node changes    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `release-check`   | Validate npm pack contents                      | After build               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `checks`          | Node/Bun tests + protocol check                 | Non-docs, node changes    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `checks-windows`  | Windows-specific tests                          | Non-docs, node changes    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `macos`           | Swift lint/build/test + TS tests                | PRs with macos changes    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `android`         | Gradle build + tests                            | Non-docs, android changes |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fail-Fast Order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Jobs are ordered so cheap checks fail before expensive ones run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `docs-scope` + `code-analysis` + `check` (parallel, ~1-2 min)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `build-artifacts` (blocked on above)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `checks`, `checks-windows`, `macos`, `android` (blocked on build)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Code Analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `code-analysis` job runs `scripts/analyze_code_files.py` on PRs to enforce code quality:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **LOC threshold**: Files that grow past 1000 lines fail the build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Delta-only**: Only checks files changed in the PR, not the entire codebase（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Push to main**: Skipped (job passes as no-op) so merges aren't blocked（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `--strict` is set, violations block all downstream jobs. This catches bloated files early before expensive tests run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Excluded directories: `node_modules`, `dist`, `vendor`, `.git`, `coverage`, `Swabble`, `skills`, `.pi`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Runners（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Runner                          | Jobs                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | ----------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `blacksmith-4vcpu-ubuntu-2404`  | Most Linux jobs               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `blacksmith-4vcpu-windows-2025` | `checks-windows`              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `macos-latest`                  | `macos`, `ios`                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `ubuntu-latest`                 | Scope detection (lightweight) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local Equivalents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm check          # types + lint + format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm test           # vitest tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm check:docs     # docs format + lint + broken links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm release:check  # validate npm pack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
