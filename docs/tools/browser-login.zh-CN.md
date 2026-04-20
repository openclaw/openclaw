---
summary: "用于浏览器自动化和 X/Twitter 发布的手动登录"
read_when:
  - 你需要登录网站进行浏览器自动化
  - 你想向 X/Twitter 发布更新
title: "浏览器登录"
---

# 浏览器登录 + X/Twitter 发布

## 手动登录（推荐）

当网站需要登录时，请在**主机**浏览器配置文件（openclaw 浏览器）中**手动登录**。

不要向模型提供你的凭据。自动登录通常会触发反机器人防御并可能锁定账户。

返回主浏览器文档：[浏览器](/tools/browser)。

## 使用哪个 Chrome 配置文件？

OpenClaw 控制一个**专用的 Chrome 配置文件**（命名为 `openclaw`，橙色色调 UI）。这与你的日常浏览器配置文件分开。

对于代理浏览器工具调用：

- 默认选择：代理应使用其隔离的 `openclaw` 浏览器。
- 仅当现有登录会话很重要且用户在计算机前点击/批准任何附加提示时，才使用 `profile="user"`。
- 如果你有多个用户浏览器配置文件，请明确指定配置文件而不是猜测。

两种访问它的简单方法：

1. **要求代理打开浏览器**，然后自己登录。
2. **通过 CLI 打开**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果你有多个配置文件，请传递 `--browser-profile <name>`（默认值为 `openclaw`）。

## X/Twitter：推荐流程

- **阅读/搜索/线程**：使用**主机**浏览器（手动登录）。
- **发布更新**：使用**主机**浏览器（手动登录）。

## 沙箱 + 主机浏览器访问

沙箱化的浏览器会话**更有可能**触发机器人检测。对于 X/Twitter（和其他严格的站点），首选**主机**浏览器。

如果代理是沙箱化的，浏览器工具默认使用沙箱。要允许主机控制：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

然后目标主机浏览器：

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

或者为发布更新的代理禁用沙箱。