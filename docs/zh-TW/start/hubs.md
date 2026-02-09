---
summary: "連結至所有 OpenClaw 文件的中樞頁面"
read_when:
  - 你想要完整掌握整份文件的地圖
title: "Docs Hubs"
---

# Docs hubs

<Note>
如果你是 OpenClaw 新手，請從 [Getting Started](/start/getting-started) 開始。
</Note>

使用這些中樞頁面來探索每一個頁面，包括左側導覽中未顯示的深入解析與參考文件。

## 從這裡開始

- [Index](/)
- [Getting Started](/start/getting-started)
- [Quick start](/start/quickstart)
- [Onboarding](/start/onboarding)
- [Wizard](/start/wizard)
- [Setup](/start/setup)
- [Dashboard（本機 Gateway 閘道器）](http://127.0.0.1:18789/)
- [Help](/help)
- [Docs directory](/start/docs-directory)
- [Configuration](/gateway/configuration)
- [Configuration examples](/gateway/configuration-examples)
- [OpenClaw assistant](/start/openclaw)
- [Showcase](/start/showcase)
- [Lore](/start/lore)

## 安裝 + 更新

- [Docker](/install/docker)
- [Nix](/install/nix)
- [Updating / rollback](/install/updating)
- [Bun workflow（實驗性）](/install/bun)

## 核心概念

- [Architecture](/concepts/architecture)
- [Features](/concepts/features)
- [Network hub](/network)
- [Agent runtime](/concepts/agent)
- [Agent workspace](/concepts/agent-workspace)
- [Memory](/concepts/memory)
- [Agent loop](/concepts/agent-loop)
- [Streaming + chunking](/concepts/streaming)
- [Multi-agent routing](/concepts/multi-agent)
- [Compaction](/concepts/compaction)
- [Sessions](/concepts/session)
- [Sessions（別名）](/concepts/sessions)
- [Session pruning](/concepts/session-pruning)
- [Session tools](/concepts/session-tool)
- [Queue](/concepts/queue)
- [Slash commands](/tools/slash-commands)
- [RPC adapters](/reference/rpc)
- [TypeBox schemas](/concepts/typebox)
- [Timezone handling](/concepts/timezone)
- [Presence](/concepts/presence)
- [Discovery + transports](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Group messages](/channels/group-messages)
- [Model failover](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## 提供者 + 入口

- [Chat channels hub](/channels)
- [Model providers hub](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram（grammY 筆記）](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost)（外掛）
- [Signal](/channels/signal)
- [BlueBubbles（iMessage）](/channels/bluebubbles)
- [iMessage（舊版）](/channels/imessage)
- [Location parsing](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway + 營運

- [Gateway runbook](/gateway)
- [Network model](/gateway/network-model)
- [Gateway pairing](/gateway/pairing)
- [Gateway lock](/gateway/gateway-lock)
- [Background process](/gateway/background-process)
- [Health](/gateway/health)
- [Heartbeat](/gateway/heartbeat)
- [Doctor](/gateway/doctor)
- [Logging](/gateway/logging)
- [Sandboxing](/gateway/sandboxing)
- [Dashboard](/web/dashboard)
- [Control UI](/web/control-ui)
- [Remote access](/gateway/remote)
- [Remote gateway README](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [Security](/gateway/security)
- [Troubleshooting](/gateway/troubleshooting)

## 工具 + 自動化

- [Tools surface](/tools)
- [OpenProse](/prose)
- [CLI reference](/cli)
- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Cron jobs](/automation/cron-jobs)
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat)
- [Thinking + verbose](/tools/thinking)
- [Models](/concepts/models)
- [Sub-agents](/tools/subagents)
- [Agent send CLI](/tools/agent-send)
- [Terminal UI](/web/tui)
- [Browser control](/tools/browser)
- [Browser（Linux 疑難排解）](/tools/browser-linux-troubleshooting)
- [Polls](/automation/poll)

## Nodes, media, voice

- [Nodes overview](/nodes)
- [Camera](/nodes/camera)
- [Images](/nodes/images)
- [Audio](/nodes/audio)
- [Location command](/nodes/location-command)
- [Voice wake](/nodes/voicewake)
- [Talk mode](/nodes/talk)

## 平台

- [Platforms overview](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows（WSL2）](/platforms/windows)
- [Linux](/platforms/linux)
- [Web surfaces](/web)

## macOS 配套應用程式（進階）

- [macOS dev setup](/platforms/mac/dev-setup)
- [macOS menu bar](/platforms/mac/menu-bar)
- [macOS voice wake](/platforms/mac/voicewake)
- [macOS voice overlay](/platforms/mac/voice-overlay)
- [macOS WebChat](/platforms/mac/webchat)
- [macOS Canvas](/platforms/mac/canvas)
- [macOS child process](/platforms/mac/child-process)
- [macOS health](/platforms/mac/health)
- [macOS icon](/platforms/mac/icon)
- [macOS logging](/platforms/mac/logging)
- [macOS permissions](/platforms/mac/permissions)
- [macOS remote](/platforms/mac/remote)
- [macOS signing](/platforms/mac/signing)
- [macOS release](/platforms/mac/release)
- [macOS gateway（launchd）](/platforms/mac/bundled-gateway)
- [macOS XPC](/platforms/mac/xpc)
- [macOS skills](/platforms/mac/skills)
- [macOS Peekaboo](/platforms/mac/peekaboo)

## Workspace + templates

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Skills config](/tools/skills-config)
- [Default AGENTS](/reference/AGENTS.default)
- [Templates: AGENTS](/reference/templates/AGENTS)
- [Templates: BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [Templates: HEARTBEAT](/reference/templates/HEARTBEAT)
- [Templates: IDENTITY](/reference/templates/IDENTITY)
- [Templates: SOUL](/reference/templates/SOUL)
- [Templates: TOOLS](/reference/templates/TOOLS)
- [Templates: USER](/reference/templates/USER)

## 實驗（探索性）

- [Onboarding config protocol](/experiments/onboarding-config-protocol)
- [Cron hardening notes](/experiments/plans/cron-add-hardening)
- [Group policy hardening notes](/experiments/plans/group-policy-hardening)
- [Research: memory](/experiments/research/memory)
- [Model config exploration](/experiments/proposals/model-config)

## 23. 專案

- [Credits](/reference/credits)

## 24. 測試 + 發佈

- [Testing](/reference/test)
- [Release checklist](/reference/RELEASING)
- [Device models](/reference/device-models)
