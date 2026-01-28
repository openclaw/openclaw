---
read_when:
  - 你需要登录网站以进行浏览器自动化
  - 你想要在 X/Twitter 上发布更新
summary: 浏览器自动化的手动登录 + X/Twitter 发帖
title: 浏览器登录
x-i18n:
  generated_at: "2026-02-01T21:39:37Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8ceea2d5258836e3db10f858ee122b5832a40f83a72ba18de140671091eef5a8
  source_path: tools/browser-login.md
  workflow: 15
---

# 浏览器登录 + X/Twitter 发帖

## 手动登录（推荐）

当网站需要登录时，请在**宿主**浏览器配置文件（openclaw 浏览器）中**手动登录**。

**不要**将你的凭据交给模型。自动登录往往会触发反机器人防御，并可能导致账号被锁定。

返回浏览器主文档：[浏览器](/tools/browser)。

## 使用哪个 Chrome 配置文件？

OpenClaw 控制一个**专用 Chrome 配置文件**（名为 `openclaw`，橙色调界面）。它与你的日常浏览器配置文件是分开的。

两种简单的访问方式：

1. **让智能体打开浏览器**，然后自己登录。
2. **通过 CLI 打开**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果你有多个配置文件，传入 `--browser-profile <name>`（默认值为 `openclaw`）。

## X/Twitter：推荐流程

- **阅读/搜索/话题串：** 使用 **bird** CLI Skills（无需浏览器，稳定可靠）。
  - 仓库：https://github.com/steipete/bird
- **发布更新：** 使用**宿主**浏览器（手动登录）。

## 沙箱 + 宿主浏览器访问

沙箱隔离的浏览器会话**更容易**触发机器人检测。对于 X/Twitter（及其他严格的网站），建议使用**宿主**浏览器。

如果智能体处于沙箱中，浏览器工具默认使用沙箱。要允许宿主控制：

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

然后指定宿主浏览器：

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

或者为发布更新的智能体禁用沙箱。
