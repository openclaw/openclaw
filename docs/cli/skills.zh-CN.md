---
summary: "`openclaw skills` 命令行参考（搜索/安装/更新/列出/信息/检查）"
read_when:
  - 你想查看哪些技能可用并准备运行
  - 你想从 ClawHub 搜索、安装或更新技能
  - 你想调试技能缺少的二进制文件/环境/配置
title: "skills"
---

# `openclaw skills`

检查本地技能并从 ClawHub 安装/更新技能。

相关：

- 技能系统：[技能](/tools/skills)
- 技能配置：[技能配置](/tools/skills-config)
- ClawHub 安装：[ClawHub](/tools/clawhub)

## 命令

```bash
openclaw skills search "calendar"
openclaw skills search --limit 20 --json
openclaw skills install <slug>
openclaw skills install <slug> --version <version>
openclaw skills install <slug> --force
openclaw skills update <slug>
openclaw skills update --all
openclaw skills list
openclaw skills list --eligible
openclaw skills list --json
openclaw skills list --verbose
openclaw skills info <name>
openclaw skills info <name> --json
openclaw skills check
openclaw skills check --json
```

`search`/`install`/`update` 直接使用 ClawHub 并安装到活动工作区的 `skills/` 目录中。`list`/`info`/`check` 仍然检查当前工作区和配置可见的本地技能。

此 CLI `install` 命令从 ClawHub 下载技能文件夹。从入职或技能设置触发的网关支持的技能依赖安装使用单独的 `skills.install` 请求路径。

注意：

- `search [query...]` 接受可选查询；省略它以浏览默认的 ClawHub 搜索 feed。
- `search --limit <n>` 限制返回的结果。
- `install --force` 覆盖同一 slug 的现有工作区技能文件夹。
- `update --all` 仅更新活动工作区中跟踪的 ClawHub 安装。
- 当未提供子命令时，`list` 是默认操作。
- `list`、`info` 和 `check` 将其渲染的输出写入 stdout。使用 `--json` 时，这意味着机器可读的有效负载保留在 stdout 上用于管道和脚本。
