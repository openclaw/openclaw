---
read_when:
  - 你想安装或管理进程内 Gateway 网关插件
  - 你想调试插件加载失败问题
summary: "`openclaw plugins` 的 CLI 参考（列出、安装、启用/禁用、诊断）"
title: plugins
x-i18n:
  generated_at: "2026-02-03T07:45:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c6bf76b1e766b912ec30a0101d455151c88f1a778bffa121cdd1d0b4fbe73e1c
  source_path: cli/plugins.md
  workflow: 15
---

# `openclaw plugins`

管理 Gateway 网关插件/扩展（进程内加载）。

相关内容：

- 插件系统：[插件](/plugin)
- 插件清单 + 模式：[插件清单](/plugins/manifest)
- 安全加固：[安全](/gateway/security)

## 命令

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

内置插件随 OpenClaw 一起发布，但默认禁用。使用 `plugins enable` 来激活它们。

所有插件必须提供 `openclaw.plugin.json` 文件，其中包含内联 JSON Schema（`configSchema`，即使为空）。缺少或无效的清单或模式会阻止插件加载并导致配置验证失败。

### 安装

```bash
openclaw plugins install <path-or-spec>
```

安全提示：将插件安装视为运行代码。优先使用固定版本。

支持的归档格式：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

使用 `--link` 避免复制本地目录（添加到 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

### 更新

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新仅适用于从 npm 安装的插件（在 `plugins.installs` 中跟踪）。
