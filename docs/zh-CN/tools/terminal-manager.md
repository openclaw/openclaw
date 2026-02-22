---
summary: "终端管理器技能：通过 /term 命令在聊天中管理 tmux 会话"
read_when:
  - 在聊天中管理终端会话
  - 使用 /term 命令
  - 终端截图
title: "终端管理器"
---

# 终端管理器

直接在聊天中管理 tmux 终端会话。创建、监控、控制和截图终端会话——无需离开你的聊天应用。

## 环境要求

- 主机已安装 `tmux`
- macOS 或 Linux
- Python 3 + Pillow（用于截图渲染）

## 工作原理

终端管理器使用专用的 tmux socket（`$TMPDIR/openclaw-term.sock`）来隔离托管会话与你日常的 tmux 使用。所有通过 `/term` 创建的会话都在这个 socket 下运行。

## 命令列表

| 命令                             | 说明                                      |
| -------------------------------- | ----------------------------------------- |
| `/term help`                     | 显示命令参考                              |
| `/term`                          | 列出所有活跃会话及其窗口和状态            |
| `/term <会话名>`                 | 显示会话最近 50 行输出                    |
| `/term <会话名> screenshot`      | 将会话输出渲染为 macOS 风格的终端截图 PNG |
| `/term <会话名> send <命令>`     | 向运行中的会话发送命令                    |
| `/term <会话名> kill`            | 终止指定会话                              |
| `/term <会话名> rename <新名称>` | 重命名会话                                |
| `/term <会话名> window <n>`      | 显示第 n 个窗口的输出                     |
| `/term new <名称> [命令]`        | 创建新会话，可选执行命令                  |
| `/term clear`                    | 终止所有托管会话                          |

## 使用示例

### 创建会话并运行命令

```
/term new devserver npm run dev
```

创建名为 `devserver` 的会话，并在其中启动 `npm run dev`。

### 查看输出

```
/term devserver
```

显示 `devserver` 会话最近 50 行终端输出。

### 终端截图

```
/term devserver screenshot
```

将终端输出渲染为带有 macOS 风格标题栏和红绿灯按钮的 PNG 图片，然后发送到聊天中。

### 向会话发送命令

```
/term devserver send ls -la
```

向 `devserver` 会话发送 `ls -la` 命令，并显示执行结果。

### 列出所有会话

```
/term
```

以表格形式显示所有活跃会话，包括窗口数量、状态和当前命令。

### 查看帮助

```
/term help
```

显示完整的命令参考。

### 重命名会话

```
/term devserver rename backend
```

将 `devserver` 会话重命名为 `backend`。

### 查看指定窗口

```
/term devserver window 1
```

显示 `devserver` 会话第 1 个窗口的最近 50 行输出。

### 从 Terminal.app 接入

你也可以将现有的终端窗口连接到托管的 tmux 服务器：

```bash
tmux -S ${TMPDIR:-/tmp}/openclaw-term.sock new-session -s mywork
```

这样该终端就可以通过 `/term` 命令进行查看和控制。

## 截图渲染

截图功能使用 Python 脚本将终端文本渲染为 macOS 风格的终端窗口 PNG 图片，包括：

- 深色背景（#1E1E1E）
- macOS 风格标题栏，带红/黄/绿交通灯按钮
- 等宽字体（SF Mono、Menlo 或 DejaVu Sans Mono）
- 最多显示 80 行输出

如果未安装 Pillow，会回退到 ImageMagick `convert`；最后兜底为纯文本输出。

## 配置

无需额外配置。技能使用默认的 tmux socket 路径：

```
${TMPDIR:-/tmp}/openclaw-term.sock
```

## 安装

通过 ClawHub 安装：

```bash
openclaw skills install terminal-manager
```

或将技能文件夹放置到 `~/.openclaw/skills/terminal-manager/`。
