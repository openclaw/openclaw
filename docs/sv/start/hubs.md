---
summary: "Nav som länkar till varje OpenClaw-dokument"
read_when:
  - Du vill ha en komplett karta över dokumentationen
title: "Dokumentnav"
---

# Dokumentnav

<Note>
Om du är ny på OpenClaw, börja med [Kom igång](/start/getting-started).
</Note>

Använd dessa nav för att upptäcka varje sida, inklusive djupdykningar och referensdokument som inte visas i vänsternavigeringen.

## Börja här

- [Index](/)
- [Kom igång](/start/getting-started)
- [Snabbstart](/start/quickstart)
- [Introduktion](/start/onboarding)
- [Guide](/start/wizard)
- [Konfigurering](/start/setup)
- [Instrumentpanel (lokal Gateway)](http://127.0.0.1:18789/)
- [Hjälp](/help)
- [Dokumentkatalog](/start/docs-directory)
- [Konfiguration](/gateway/configuration)
- [Konfigurationsexempel](/gateway/configuration-examples)
- [OpenClaw-assistent](/start/openclaw)
- [Showcase](/start/showcase)
- [Lore](/start/lore)

## Installation + uppdateringar

- [Docker](/install/docker)
- [Nix](/install/nix)
- [Uppdatering / återställning](/install/updating)
- [Bun-arbetsflöde (experimentellt)](/install/bun)

## Grundläggande koncept

- [Arkitektur](/concepts/architecture)
- [Funktioner](/concepts/features)
- [Nätverksnav](/network)
- [Agentkörmiljö](/concepts/agent)
- [Agentarbetsyta](/concepts/agent-workspace)
- [Minne](/concepts/memory)
- [Agentloop](/concepts/agent-loop)
- [Strömning + chunking](/concepts/streaming)
- [Multiagent-routing](/concepts/multi-agent)
- [Kompaktering](/concepts/compaction)
- [Sessioner](/concepts/session)
- [Sessioner (alias)](/concepts/sessions)
- [Sessionbeskärning](/concepts/session-pruning)
- [Sessionsverktyg](/concepts/session-tool)
- [Kö](/concepts/queue)
- [Slash-kommandon](/tools/slash-commands)
- [RPC-adaptrar](/reference/rpc)
- [TypeBox-scheman](/concepts/typebox)
- [Tidszonshantering](/concepts/timezone)
- [Närvaro](/concepts/presence)
- [Discovery + transporter](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [Kanalrouting](/channels/channel-routing)
- [Grupper](/channels/groups)
- [Gruppmeddelanden](/channels/group-messages)
- [Modell-failover](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## Leverantörer + ingress

- [Nav för chattkanaler](/channels)
- [Nav för modellleverantörer](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram (grammY-anteckningar)](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost) (plugin)
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage (legacy)](/channels/imessage)
- [Platsparsning](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway + drift

- [Gateway-runbook](/gateway)
- [Nätverksmodell](/gateway/network-model)
- [Gateway-parkoppling](/gateway/pairing)
- [Gateway-lås](/gateway/gateway-lock)
- [Bakgrundsprocess](/gateway/background-process)
- [Hälsa](/gateway/health)
- [Heartbeat](/gateway/heartbeat)
- [Doctor](/gateway/doctor)
- [Loggning](/gateway/logging)
- [Sandboxing](/gateway/sandboxing)
- [Instrumentpanel](/web/dashboard)
- [Kontroll-UI](/web/control-ui)
- [Fjärråtkomst](/gateway/remote)
- [README för fjärr-Gateway](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [Säkerhet](/gateway/security)
- [Felsökning](/gateway/troubleshooting)

## Verktyg + automation

- [Verktygsyta](/tools)
- [OpenProse](/prose)
- [CLI-referens](/cli)
- [Exec-verktyg](/tools/exec)
- [Förhöjt läge](/tools/elevated)
- [Cron-jobb](/automation/cron-jobs)
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat)
- [Tänkande + verbose](/tools/thinking)
- [Modeller](/concepts/models)
- [Subagenter](/tools/subagents)
- [Agent send CLI](/tools/agent-send)
- [Terminal-UI](/web/tui)
- [Webbläsarkontroll](/tools/browser)
- [Webbläsare (Linux-felsökning)](/tools/browser-linux-troubleshooting)
- [Omröstningar](/automation/poll)

## Noder, media, röst

- [Översikt över noder](/nodes)
- [Kamera](/nodes/camera)
- [Bilder](/nodes/images)
- [Ljud](/nodes/audio)
- [Platskommando](/nodes/location-command)
- [Röstväckning](/nodes/voicewake)
- [Tal-läge](/nodes/talk)

## Plattformar

- [Plattformsöversikt](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Webbytor](/web)

## macOS Companion-app (avancerat)

- [macOS utvecklingssetup](/platforms/mac/dev-setup)
- [macOS-menyrad](/platforms/mac/menu-bar)
- [macOS röstväckning](/platforms/mac/voicewake)
- [macOS röstoverlay](/platforms/mac/voice-overlay)
- [macOS WebChat](/platforms/mac/webchat)
- [macOS Canvas](/platforms/mac/canvas)
- [macOS barnprocess](/platforms/mac/child-process)
- [macOS hälsa](/platforms/mac/health)
- [macOS ikon](/platforms/mac/icon)
- [macOS loggning](/platforms/mac/logging)
- [macOS behörigheter](/platforms/mac/permissions)
- [macOS fjärr](/platforms/mac/remote)
- [macOS signering](/platforms/mac/signing)
- [macOS release](/platforms/mac/release)
- [macOS Gateway (launchd)](/platforms/mac/bundled-gateway)
- [macOS XPC](/platforms/mac/xpc)
- [macOS Skills](/platforms/mac/skills)
- [macOS Peekaboo](/platforms/mac/peekaboo)

## Arbetsyta + mallar

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Skills-konfig](/tools/skills-config)
- [Standard AGENTS](/reference/AGENTS.default)
- [Mallar: AGENTS](/reference/templates/AGENTS)
- [Mallar: BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [Mallar: HEARTBEAT](/reference/templates/HEARTBEAT)
- [Mallar: IDENTITY](/reference/templates/IDENTITY)
- [Mallar: SOUL](/reference/templates/SOUL)
- [Mallar: TOOLS](/reference/templates/TOOLS)
- [Mallar: USER](/reference/templates/USER)

## Experiment (utforskande)

- [Introduktionskonfigurationsprotokoll](/experiments/onboarding-config-protocol)
- [Anteckningar om härdning av Cron](/experiments/plans/cron-add-hardening)
- [Anteckningar om härdning av grupppolicy](/experiments/plans/group-policy-hardening)
- [Forskning: minne](/experiments/research/memory)
- [Utforskning av modellkonfig](/experiments/proposals/model-config)

## Projekt

- [Tack](/reference/credits)

## Testning + release

- [Testning](/reference/test)
- [Checklista för release](/reference/RELEASING)
- [Enhetsmodeller](/reference/device-models)
