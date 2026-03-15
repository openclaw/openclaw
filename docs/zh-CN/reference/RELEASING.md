---
read_when:
  - 查找维护者发布流程
  - 追踪仓库中的发布自动化
summary: 维护者发布流程位于私有维护者仓库中
title: 发布清单
---

# 发布清单（npm + macOS）

OpenClaw 的发布流程维护在私有 `openclaw/maintainers` 仓库中。这个公开仓库保留工作流和脚本，但不再保留维护者发布手册。

维护者请使用私有发布手册：

- [`release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)

本仓库中的公开工作流和脚本参考：

- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/openclaw-npm-publish.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-publish.sh)
- [`scripts/release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)
- [`appcast.xml`](https://github.com/openclaw/openclaw/blob/main/appcast.xml)

审批、凭据、恢复说明以及实际发布步骤都保留在维护者仓库中。
