---
read_when:
  - 你想要一份完整的文档地图
summary: 链接到每篇 OpenClaw 文档的导航中心
title: 文档导航中心
x-i18n:
  generated_at: "2026-02-04T17:55:29Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c4b4572b64d36c9690988b8f964b0712f551ee6491b18a493701a17d2d352cb4
  source_path: start/hubs.md
  workflow: 15
---

# 文档导航中心

使用这些导航中心发现每一个页面，包括深入解析和参考文档——它们不一定出现在左侧导航栏中。

## 从这里开始

- [索引](/)
- [入门指南](/start/getting-started)
- [快速开始](/start/quickstart)
- [新手引导](/start/onboarding)
- [向导](/start/wizard)
- [安装配置](/start/setup)
- [仪表盘（本地 Gateway 网关）](http://127.0.0.1:18789/)
- [帮助](/help)
- [文档目录](/start/docs-directory)
- [配置](/gateway/configuration)
- [配置示例](/gateway/configuration-examples)
- [OpenClaw 助手](/start/openclaw)
- [展示](/start/showcase)
- [背景故事](/start/lore)

## 安装 + 更新

- [Docker](/install/docker)
- [Nix](/install/nix)
- [更新 / 回滚](/install/updating)
- [Bun 工作流（实验性）](/install/bun)

## 核心概念

- [架构](/concepts/architecture)
- [功能](/concepts/features)
- [网络中心](/network)
- [智能体运行时](/concepts/agent)
- [智能体工作区](/concepts/agent-workspace)
- [记忆](/concepts/memory)
- [智能体循环](/concepts/agent-loop)
- [流式传输 + 分块](/concepts/streaming)
- [多智能体路由](/concepts/multi-agent)
- [压缩](/concepts/compaction)
- [会话](/concepts/session)
- [会话（别名）](/concepts/sessions)
- [会话修剪](/concepts/session-pruning)
- [会话工具](/concepts/session-tool)
- [队列](/concepts/queue)
- [斜杠命令](/tools/slash-commands)
- [RPC 适配器](/reference/rpc)
- [TypeBox 模式](/concepts/typebox)
- [时区处理](/concepts/timezone)
- [在线状态](/concepts/presence)
- [设备发现 + 传输协议](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [渠道路由](/concepts/channel-routing)
- [群组](/concepts/groups)
- [群组消息](/concepts/group-messages)
- [模型故障转移](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## 提供商 + 入口

- [聊天渠道中心](/channels)
- [模型提供商中心](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram（grammY 注意事项）](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost)（插件）
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage（旧版）](/channels/imessage)
- [位置解析](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway 网关 + 运维

- [Gateway 网关运维手册](/gateway)
- [网络模型](/gateway/network-model)
- [Gateway 网关配对](/gateway/pairing)
- [Gateway 网关锁](/gateway/gateway-lock)
- [后台进程](/gateway/background-process)
- [健康检查](/gateway/health)
- [心跳](/gateway/heartbeat)
- [Doctor](/gateway/doctor)
- [日志](/gateway/logging)
- [沙箱隔离](/gateway/sandboxing)
- [仪表盘](/web/dashboard)
- [控制界面](/web/control-ui)
- [远程访问](/gateway/remote)
- [远程 Gateway 网关 README](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [安全](/gateway/security)
- [故障排除](/gateway/troubleshooting)

## 工具 + 自动化

- [工具概览](/tools)
- [OpenProse](/prose)
- [CLI 参考](/cli)
- [Exec 工具](/tools/exec)
- [提权模式](/tools/elevated)
- [定时任务](/automation/cron-jobs)
- [定时任务 vs 心跳](/automation/cron-vs-heartbeat)
- [思考 + 详细输出](/tools/thinking)
- [模型](/concepts/models)
- [子智能体](/tools/subagents)
- [Agent send CLI](/tools/agent-send)
- [终端界面](/tui)
- [浏览器控制](/tools/browser)
- [浏览器（Linux 故障排除）](/tools/browser-linux-troubleshooting)
- [轮询](/automation/poll)

## 节点、媒体、语音

- [节点概览](/nodes)
- [摄像头](/nodes/camera)
- [图片](/nodes/images)
- [音频](/nodes/audio)
- [位置命令](/nodes/location-command)
- [语音唤醒](/nodes/voicewake)
- [对话模式](/nodes/talk)

## 平台

- [平台概览](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Web 界面](/web)

## macOS 配套应用（高级）

- [macOS 开发环境配置](/platforms/mac/dev-setup)
- [macOS 菜单栏](/platforms/mac/menu-bar)
- [macOS 语音唤醒](/platforms/mac/voicewake)
- [macOS 语音悬浮窗](/platforms/mac/voice-overlay)
- [macOS WebChat](/platforms/mac/webchat)
- [macOS Canvas](/platforms/mac/canvas)
- [macOS 子进程](/platforms/mac/child-process)
- [macOS 健康检查](/platforms/mac/health)
- [macOS 图标](/platforms/mac/icon)
- [macOS 日志](/platforms/mac/logging)
- [macOS 权限](/platforms/mac/permissions)
- [macOS 远程](/platforms/mac/remote)
- [macOS 签名](/platforms/mac/signing)
- [macOS 发布](/platforms/mac/release)
- [macOS Gateway 网关 (launchd)](/platforms/mac/bundled-gateway)
- [macOS XPC](/platforms/mac/xpc)
- [macOS Skills](/platforms/mac/skills)
- [macOS Peekaboo](/platforms/mac/peekaboo)

## 工作区 + 模板

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Skills 配置](/tools/skills-config)
- [默认 AGENTS](/reference/AGENTS.default)
- [模板：AGENTS](/reference/templates/AGENTS)
- [模板：BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [模板：HEARTBEAT](/reference/templates/HEARTBEAT)
- [模板：IDENTITY](/reference/templates/IDENTITY)
- [模板：SOUL](/reference/templates/SOUL)
- [模板：TOOLS](/reference/templates/TOOLS)
- [模板：USER](/reference/templates/USER)

## 实验（探索性）

- [新手引导配置协议](/experiments/onboarding-config-protocol)
- [定时任务加固笔记](/experiments/plans/cron-add-hardening)
- [群组策略加固笔记](/experiments/plans/group-policy-hardening)
- [研究：记忆](/experiments/research/memory)
- [模型配置探索](/experiments/proposals/model-config)

## 项目

- [致谢](/reference/credits)

## 测试 + 发布

- [测试](/reference/test)
- [发布检查清单](/reference/RELEASING)
- [设备型号](/reference/device-models)
