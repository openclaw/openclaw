# scripts/

> 318 个脚本文件。按功能分类，方便快速定位。

## 目录

| 分类 | 文件数 | 说明 |
|------|--------|------|
| [Check / Validation](#check--validation) | 61 | 代码检查、边界验证、架构审计 |
| [Test / Benchmark](#test--benchmark) | 37 | 单元测试、E2E、性能基准 |
| [Config / Generation](#config--generation) | 23 | 配置生成、元数据同步、基线写入 |
| [Run / Start](#run--start) | 18 | 节点运行、lint 执行、测试运行器 |
| [Other](#other) | 123 | 安装、发布、平台打包、沙箱、工具类 |
| [Build](#build) | 9 | 构建打包、A2UI 绑定 |
| [CI](#ci) | 7 | CI 环境准备、计时、认证注入 |
| [Docs](#docs) | 10 | 文档链接审计、拼写检查、i18n |
| [Platform-specific](#platform-specific) | 10 | iOS 发布流程 |
| [Plugin / Skill](#plugin--skill) | 10 | 插件发布、ClawHub、SDK 报告 |
| [Release / Changelog](#release--changelog) | 5 | 发布前检查、beta 冒烟 |
| [Analysis / Monitor](#analysis--monitor) | 2 | 使用分析、认证监控 |
| [Security](#security) | 1 | 代码缝审计 |

## Check / Validation

所有 `check-*` 脚本。运行 `pnpm check` 执行全部检查。

| 脚本 | 说明 |
|------|------|
| `check.mjs` | 主入口，聚合所有检查 |
| `check-architecture-smells.mjs` | 架构异味检测 |
| `check-changed.mjs` | 检查变更范围 |
| `check-changelog-attributions.mjs` | CHANGELOG 归属检查 |
| `check-cli-bootstrap-imports.mjs` | CLI 启动导入检查 |
| `check-cli-startup-memory.mjs` | CLI 启动内存检查 |
| `check-import-cycles.ts` | 导入循环检测 |
| `check-madge-import-cycles.ts` | Madge 导入循环检测 |
| `check-no-conflict-markers.mjs` | 冲突标记检查 |
| `check-no-deprecated-channel-access.ts` | 废弃 channel 访问检查 |
| `check-no-extension-src-imports.ts` | 扩展 src 导入检查 |
| `check-plugin-gateway-gauntlet.mjs` | 插件网关全面检查 |
| `check-plugin-sdk-exports.mjs` | 插件 SDK 导出检查 |
| `check-timed.mjs` | 定时检查 |
| `check-ts-max-loc.ts` | TypeScript 文件行数上限检查 |
| `check-workflows.mjs` | GitHub Actions workflow 检查 |
| _…以及其他 45 个 check 脚本_ |

## Test / Benchmark

| 脚本 | 说明 |
|------|------|
| `bench-cli-startup.ts` | CLI 启动基准测试 |
| `bench-gateway-startup.ts` | Gateway 启动基准测试 |
| `bench-model.ts` | 模型性能基准 |
| `bench-test-changed.mjs` | 变更文件测试基准 |
| `run-vitest.mjs` | Vitest 测试运行器 |
| `run-vitest-profile.mjs` | 带性能分析的 Vitest |
| `test-extension.mjs` | 扩展测试 |
| `test-extension-batch.mjs` | 批量扩展测试 |
| `test-live.mjs` | 实时集成测试 |
| `test-unit-fast-audit.mjs` | 快速单元测试审计 |
| `test-perf-budget.mjs` | 性能预算测试 |
| _…以及其他 26 个测试/基准脚本_ |

## Config / Generation

| 脚本 | 说明 |
|------|------|
| `generate-base-config-schema.ts` | 生成基础配置 schema |
| `generate-bundled-channel-config-metadata.ts` | 生成 channel 配置元数据 |
| `generate-config-doc-baseline.ts` | 生成配置文档基线 |
| `sync-labels.ts` | 同步 GitHub labels |
| `sync-plugin-versions.ts` | 同步插件版本 |
| `write-build-info.ts` | 写入构建信息 |
| `write-cli-compat.ts` | 写入 CLI 兼容性信息 |
| `write-cli-startup-metadata.ts` | 写入 CLI 启动元数据 |
| _…以及其他 15 个生成/同步脚本_ |

## Run / Start

| 脚本 | 说明 |
|------|------|
| `run-node.mjs` | Node 运行封装 |
| `run-tsgo.mjs` | TypeScript 编译器运行 |
| `run-oxlint.mjs` | Oxlint 运行 |
| `run-opengrep.sh` | OpenGrep 运行 |
| `gateway-watch-tmux.mjs` | Tmux 中启动 gateway watch |
| _…以及其他 13 个运行脚本_ |

## Build

| 脚本 | 说明 |
|------|------|
| `build-all.mjs` | 主构建入口 |
| `bundle-a2ui.mjs` | A2UI 资源绑定 |
| `bundled-plugin-assets.mjs` | 插件资源打包 |
| `build-stamp.mjs` | 构建戳生成 |
| `build-and-run-mac.sh` | macOS 构建并运行 |

## CI

| 脚本 | 说明 |
|------|------|
| `ci-changed-scope.mjs` | 检测变更范围 |
| `ci-docker-pull-retry.sh` | Docker pull 重试 |
| `ci-hydrate-live-auth.sh` | CI 认证注入 |
| `ci-hydrate-testbox-env.sh` | 测试环境注入 |
| `ci-live-command-retry.sh` | 实时命令重试 |
| `ci-run-timings.mjs` | CI 运行计时 |

## Plugin / Skill

| 脚本 | 说明 |
|------|------|
| `plugin-clawhub-publish.sh` | 发布到 ClawHub |
| `plugin-clawhub-release-check.ts` | ClawHub 发布前检查 |
| `plugin-clawhub-release-plan.ts` | ClawHub 发布计划 |
| `plugin-npm-publish.sh` | npm 发布 |
| `plugin-npm-release-check.ts` | npm 发布前检查 |
| `plugin-npm-release-plan.ts` | npm 发布计划 |
| `plugin-sdk-surface-report.mjs` | SDK 接口报告 |
| `plugin-boundary-report.ts` | 插件边界报告 |

## Release / Changelog

| 脚本 | 说明 |
|------|------|
| `changelog-add-unreleased.ts` | 添加未发布条目到 CHANGELOG |
| `changelog-to-html.sh` | CHANGELOG 转 HTML |
| `release-beta-smoke.ts` | Beta 冒烟测试 |
| `release-check.ts` | 发布前检查 |
| `release-preflight.mjs` | 发布预检 |

## Docs

| 脚本 | 说明 |
|------|------|
| `docs-link-audit.mjs` | 文档链接审计 |
| `docs-spellcheck.sh` | 文档拼写检查 |
| `docs-sync-publish.mjs` | 文档同步发布 |
| `format-docs.mjs` | 文档格式化 |
| `docs-list.js` | 文档列表生成 |

## Platform-specific

全部 iOS 相关脚本（beta 发布、签名、版本同步）。

## Security

| 脚本 | 说明 |
|------|------|
| `audit-seams.mjs` | 代码缝审计 |

## Analysis / Monitor

| 脚本 | 说明 |
|------|------|
| `analyze-plugin-sdk-usage.ts` | 插件 SDK 使用分析 |
| `auth-monitor.sh` | 认证状态监控 |

## Other

其余 123 个脚本，包括安装、发布、沙箱配置、平台打包、工具类等。详见各文件头部注释。

---

> **提示**：也可以用 `just --list` 查看常用任务的快捷命令。
