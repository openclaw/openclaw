---
read_when:
  - 查找公开发布渠道的定义
  - 查找版本命名与发布节奏
summary: 公开发布渠道、版本命名与发布节奏
title: 发布策略
x-i18n:
  generated_at: "2026-03-15T19:23:11Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: df332d3169de7099661725d9266955456e80fc3d3ff95cb7aaf9997a02f0baaf
  source_path: reference/RELEASING.md
  workflow: 15
---

# 发布策略

Mullusi 有三个公开发布渠道：

- stable：带标签的正式发布，发布到 npm `latest`
- beta：预发布标签，发布到 npm `beta`
- dev：`main` 分支的最新提交

## 版本命名

- 正式发布版本号：`YYYY.M.D`
  - Git 标签：`vYYYY.M.D`
- Beta 预发布版本号：`YYYY.M.D-beta.N`
  - Git 标签：`vYYYY.M.D-beta.N`
- 月份和日期不补零
- `latest` 表示当前 npm 正式发布版本
- `beta` 表示当前 npm 预发布版本
- Beta 版本可能会在 macOS 应用跟进之前发布

## 发布节奏

- 发布遵循 beta 优先原则
- 仅在最新的 beta 版本验证通过后才会发布正式版本
- 详细的发布流程、审批、凭证和恢复说明仅限维护者查阅

## 公开参考

- [`.github/workflows/mullusi-npm-release.yml`](https://github.com/mullusi/mullusi/blob/main/.github/workflows/mullusi-npm-release.yml)
- [`scripts/mullusi-npm-release-check.ts`](https://github.com/mullusi/mullusi/blob/main/scripts/mullusi-npm-release-check.ts)

维护者使用
[`mullusi/maintainers/release/README.md`](https://github.com/mullusi/maintainers/blob/main/release/README.md)
中的私有发布文档作为实际操作手册。
