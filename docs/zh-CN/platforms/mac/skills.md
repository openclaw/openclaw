---
read_when:
  - 更新 macOS Skills 设置 UI
  - 更改 Skills 门控或安装行为
summary: macOS Skills 设置 UI 及 Gateway网关支持的状态
title: Skills
x-i18n:
  generated_at: "2026-02-01T21:33:07Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ecd5286bbe49eed89319686c4f7d6da55ef7b0d3952656ba98ef5e769f3fbf79
  source_path: platforms/mac/skills.md
  workflow: 15
---

# Skills（macOS）

macOS 应用通过 Gateway网关展示 OpenClaw Skills；不会在本地解析 Skills。

## 数据来源

- `skills.status`（Gateway网关）返回所有 Skills 及其资格和缺失的依赖项
  （包括内置 Skills 的白名单限制）。
- 依赖项来源于每个 `SKILL.md` 中的 `metadata.openclaw.requires`。

## 安装操作

- `metadata.openclaw.install` 定义安装选项（brew/node/go/uv）。
- 应用调用 `skills.install` 在 Gateway网关主机上运行安装程序。
- 当提供多个安装程序时，Gateway网关仅展示一个首选安装程序
  （优先使用 brew，否则使用 `skills.install` 中的 node 管理器，默认为 npm）。

## 环境变量/API 密钥

- 应用将密钥存储在 `~/.openclaw/openclaw.json` 的 `skills.entries.<skillKey>` 下。
- `skills.update` 可修改 `enabled`、`apiKey` 和 `env`。

## 远程模式

- 安装和配置更新在 Gateway网关主机上执行（而非本地 Mac）。
