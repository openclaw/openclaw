---
summary: "ฮับที่เชื่อมโยงไปยังเอกสาร OpenClaw ทุกหน้า"
read_when:
  - คุณต้องการแผนผังเอกสารทั้งหมด
title: "ฮับเอกสาร"
---

# ฮับเอกสาร

<Note>
หากคุณเพิ่งเริ่มใช้ OpenClaw ให้เริ่มจาก [Getting Started](/start/getting-started)
</Note>

ใช้ฮับเหล่านี้เพื่อค้นหาทุกหน้า รวมถึงบทความเชิงลึกและเอกสารอ้างอิงที่ไม่ปรากฏในแถบนำทางด้านซ้าย

## เริ่มต้นที่นี่

- [Index](/)
- [Getting Started](/start/getting-started)
- [Quick start](/start/quickstart)
- [Onboarding](/start/onboarding)
- [Wizard](/start/wizard)
- [Setup](/start/setup)
- [Dashboard (local Gateway)](http://127.0.0.1:18789/)
- [Help](/help)
- [Docs directory](/start/docs-directory)
- [Configuration](/gateway/configuration)
- [Configuration examples](/gateway/configuration-examples)
- [OpenClaw assistant](/start/openclaw)
- [Showcase](/start/showcase)
- [Lore](/start/lore)

## การติดตั้ง+การอัปเดต

- [Docker](/install/docker)
- [Nix](/install/nix)
- [Updating / rollback](/install/updating)
- [Bun workflow (experimental)](/install/bun)

## แนวคิดหลัก

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
- [Sessions (alias)](/concepts/sessions)
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

## ผู้ให้บริการ+อินเกรส

- [Chat channels hub](/channels)
- [Model providers hub](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram (grammY notes)](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost) (plugin)
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage (legacy)](/channels/imessage)
- [Location parsing](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway+การปฏิบัติการ

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

## เครื่องมือ+อัตโนมัติ

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
- [Browser (Linux troubleshooting)](/tools/browser-linux-troubleshooting)
- [Polls](/automation/poll)

## โหนดสื่อและเสียง

- [Nodes overview](/nodes)
- [Camera](/nodes/camera)
- [Images](/nodes/images)
- [Audio](/nodes/audio)
- [Location command](/nodes/location-command)
- [Voice wake](/nodes/voicewake)
- [Talk mode](/nodes/talk)

## แพลตฟอร์ม

- [Platforms overview](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Web surfaces](/web)

## แอปคู่หูmacOS(ขั้นสูง)

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
- [macOS gateway (launchd)](/platforms/mac/bundled-gateway)
- [macOS XPC](/platforms/mac/xpc)
- [macOS skills](/platforms/mac/skills)
- [macOS Peekaboo](/platforms/mac/peekaboo)

## เวิร์กสเปซ+เทมเพลต

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

## การทดลอง(เชิงสำรวจ)

- [Onboarding config protocol](/experiments/onboarding-config-protocol)
- [Cron hardening notes](/experiments/plans/cron-add-hardening)
- [Group policy hardening notes](/experiments/plans/group-policy-hardening)
- [Research: memory](/experiments/research/memory)
- [Model config exploration](/experiments/proposals/model-config)

## โครงการ

- [Credits](/reference/credits)

## การทดสอบ+การรีลีส

- [Testing](/reference/test)
- [Release checklist](/reference/RELEASING)
- [Device models](/reference/device-models)
