---
read_when:
  - 你已安装 OpenClaw 但 `openclaw` 提示"command not found"
  - 你正在新机器上配置 Node.js/npm
  - npm install -g ... 因权限或 PATH 问题失败
summary: Node.js + npm 安装完整性检查：版本、PATH 及全局安装
title: Node.js + npm（PATH 安装完整性检查）
x-i18n:
  generated_at: "2026-02-01T21:16:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9f6d83be362e3e148ddf07d47e57c51679c22687263d3b5131cccbef2e37c598
  source_path: install/node.md
  workflow: 15
---

# Node.js + npm（PATH 安装完整性检查）

OpenClaw 的运行时基线要求为 **Node 22+**。

如果你能运行 `npm install -g openclaw@latest`，但之后看到 `openclaw: command not found`，这几乎总是 **PATH** 问题：npm 存放全局二进制文件的目录不在你 shell 的 PATH 中。

## 快速诊断

运行：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

如果 `$(npm prefix -g)/bin`（macOS/Linux）或 `$(npm prefix -g)`（Windows）**未出现**在 `echo "$PATH"` 的输出中，你的 shell 就无法找到全局 npm 二进制文件（包括 `openclaw`）。

## 修复：将 npm 的全局 bin 目录添加到 PATH

1. 查找你的全局 npm 前缀：

```bash
npm prefix -g
```

2. 将全局 npm bin 目录添加到你的 shell 启动文件中：

- zsh：`~/.zshrc`
- bash：`~/.bashrc`

示例（将路径替换为你的 `npm prefix -g` 输出）：

```bash
# macOS / Linux
export PATH="/path/from/npm/prefix/bin:$PATH"
```

然后打开一个**新终端**（或在 zsh 中运行 `rehash` / 在 bash 中运行 `hash -r`）。

在 Windows 上，将 `npm prefix -g` 的输出添加到你的 PATH 中。

## 修复：避免 `sudo npm install -g` / 权限错误（Linux）

如果 `npm install -g ...` 因 `EACCES` 失败，请将 npm 的全局前缀切换到用户可写的目录：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

将 `export PATH=...` 这一行持久化到你的 shell 启动文件中。

## 推荐的 Node 安装方式

如果 Node/npm 的安装方式满足以下条件，你将遇到最少的问题：

- 保持 Node 更新（22+）
- 使全局 npm bin 目录稳定且在新 shell 中位于 PATH 中

常见选择：

- macOS：Homebrew（`brew install node`）或版本管理器
- Linux：你偏好的版本管理器，或提供 Node 22+ 的发行版支持的安装方式
- Windows：官方 Node 安装程序、`winget` 或 Windows Node 版本管理器

如果你使用版本管理器（nvm/fnm/asdf 等），请确保它在你日常使用的 shell（zsh 或 bash）中已初始化，这样它设置的 PATH 在你运行安装程序时才会生效。
