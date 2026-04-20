---
summary: "`openclaw dns`的CLI参考（广域发现助手）"
read_when:
  - 您需要通过Tailscale + CoreDNS进行广域发现（DNS-SD）
  - 您正在为自定义发现域设置拆分DNS（例如：openclaw.internal）
title: "dns"
---

# `openclaw dns`

用于广域发现的DNS助手（Tailscale + CoreDNS）。目前专注于macOS + Homebrew CoreDNS。

相关：

- Gateway发现：[Discovery](/gateway/discovery)
- 广域发现配置：[Configuration](/gateway/configuration)

## 设置

```bash
openclaw dns setup
openclaw dns setup --domain openclaw.internal
openclaw dns setup --apply
```

## `dns setup`

计划或应用用于单播DNS-SD发现的CoreDNS设置。

选项：

- `--domain <domain>`: 广域发现域（例如 `openclaw.internal`）
- `--apply`: 安装或更新CoreDNS配置并重启服务（需要sudo；仅限macOS）

它显示的内容：

- 解析的发现域
- 区域文件路径
- 当前的tailnet IP
- 推荐的`openclaw.json`发现配置
- 要设置的Tailscale拆分DNS名称服务器/域值

注意事项：

- 没有`--apply`，该命令只是一个规划助手，打印推荐的设置。
- 如果省略`--domain`，OpenClaw会使用配置中的`discovery.wideArea.domain`。
- `--apply`目前仅支持macOS，并且需要Homebrew CoreDNS。
- `--apply`在需要时引导区域文件，确保CoreDNS导入节存在，并重启`coredns` brew服务。