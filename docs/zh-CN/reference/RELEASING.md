---
read_when:
  - 查找公开的发布渠道定义
  - 查找版本命名和发布节奏
summary: 公开的发布渠道、版本命名和发布节奏
title: 发布策略
---

# 发布策略

OpenClaw 有三条公开的发布通道：

- stable：带标签的稳定版本，发布到 npm `latest`
- beta：预发布版本，发布到 npm `beta`
- dev：`main` 分支的持续更新版本

## 版本命名

- 稳定版本：`YYYY.M.D`
  - Git 标签：`vYYYY.M.D`
- Beta 预发布版本：`YYYY.M.D-beta.N`
  - Git 标签：`vYYYY.M.D-beta.N`
- 月和日不要补零
- `latest` 表示当前稳定版 npm 发布
- `beta` 表示当前预发布 npm 发布
- Beta 发布可能会先于 macOS 应用版本更新

## 发布节奏

- 发布先走 beta
- stable 只会在最新 beta 验证完成后跟进
- 详细的发布流程、审批、凭据和恢复说明仅供维护者使用

## 公开参考

- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)

维护者实际使用的发布手册位于私有仓库
[`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)。
