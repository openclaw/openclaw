---
read_when: Browser control fails on Linux, especially with snap Chromium
summary: 修复 Linux 上 OpenClaw 浏览器控制的 Chrome/Brave/Edge/Chromium CDP 启动问题
title: 浏览器故障排除
x-i18n:
  generated_at: "2026-02-01T21:39:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bac2301022511a0bf8ebe1309606cc03e8a979ff74866c894f89d280ca3e514e
  source_path: tools/browser-linux-troubleshooting.md
  workflow: 15
---

# 浏览器故障排除（Linux）

## 问题："Failed to start Chrome CDP on port 18800"

OpenClaw 的浏览器控制服务器无法启动 Chrome/Brave/Edge/Chromium，报错如下：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

在 Ubuntu（以及许多 Linux 发行版）上，默认的 Chromium 安装是一个 **snap 包**。Snap 的 AppArmor 沙箱限制会干扰 OpenClaw 生成和监控浏览器进程的方式。

`apt install chromium` 命令安装的是一个重定向到 snap 的占位包：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

这不是一个真正的浏览器——它只是一个包装器。

### 方案 1：安装 Google Chrome（推荐）

安装官方的 Google Chrome `.deb` 包，它不受 snap 沙箱限制：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 如果有依赖错误
```

然后更新你的 OpenClaw 配置（`~/.openclaw/openclaw.json`）：

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### 方案 2：使用 Snap Chromium 的仅附加模式

如果你必须使用 snap Chromium，请配置 OpenClaw 附加到手动启动的浏览器：

1. 更新配置：

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. 手动启动 Chromium：

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. 可选创建一个 systemd 用户服务来自动启动 Chrome：

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启用命令：`systemctl --user enable --now openclaw-browser.service`

### 验证浏览器是否正常工作

检查状态：

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

测试浏览：

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 配置参考

| 选项                     | 描述                                                          | 默认值                                           |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------ |
| `browser.enabled`        | 启用浏览器控制                                                | `true`                                           |
| `browser.executablePath` | Chromium 系浏览器二进制文件路径（Chrome/Brave/Edge/Chromium） | 自动检测（当默认浏览器为 Chromium 系时优先使用） |
| `browser.headless`       | 无界面运行                                                    | `false`                                          |
| `browser.noSandbox`      | 添加 `--no-sandbox` 标志（某些 Linux 环境需要）               | `false`                                          |
| `browser.attachOnly`     | 不启动浏览器，仅附加到现有实例                                | `false`                                          |
| `browser.cdpPort`        | Chrome DevTools Protocol 端口                                 | `18800`                                          |

### 问题："Chrome extension relay is running, but no tab is connected"

你正在使用 `chrome` 配置文件（扩展中继）。它需要 OpenClaw
浏览器扩展附加到一个活动标签页。

修复方案：

1. **使用托管浏览器：** `openclaw browser start --browser-profile openclaw`
   （或设置 `browser.defaultProfile: "openclaw"`）。
2. **使用扩展中继：** 安装扩展，打开一个标签页，然后点击
   OpenClaw 扩展图标进行附加。

说明：

- `chrome` 配置文件会尽可能使用你的**系统默认 Chromium 浏览器**。
- 本地 `openclaw` 配置文件会自动分配 `cdpPort`/`cdpUrl`；仅在远程 CDP 时需要手动设置。
