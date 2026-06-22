---
title: "Maturity taxonomy"
summary: "Detailed reference for the product areas and checks behind the OpenClaw maturity scorecard."
---

# Maturity taxonomy

This page explains the product areas and capability groups behind the maturity scorecard.

## Maturity levels

| Level | Label        | Meaning                                                                                     | Promotion bar                                                                                                          |
| ----- | ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `M0`  | Planned      | Direction is known, but no supported user path exists.                                      | Design issue, owner, and target surface exist.                                                                         |
| `M1`  | Experimental | Implemented behind caveats, flags, source builds, or maintainer-only flows.                 | Maintainer can run the scenario from current main.                                                                     |
| `M2`  | Alpha        | Real users can try it, but breaking changes and incomplete UX are expected.                 | Documented setup, basic tests, known caveats, and at least one real-environment proof.                                 |
| `M3`  | Beta         | Public path exists and the main workflow is usable with bounded caveats.                    | Install/update docs, regression tests, support runbook, and successful scenario proof across the expected environment. |
| `M4`  | Stable       | Recommended path for normal users. Failures are treated as regressions.                     | Release gate, doctor/troubleshooting path, broad docs, and repeated real-world proof.                                  |
| `M5`  | Lovable      | Polished, delightful, well-instrumented, and competitive with the best comparable workflow. | Stable plus user scorecard pass across representative users.                                                           |

## Product areas

### Core

- [Gateway runtime](#gateway-runtime)
- [CLI](#cli)
- [Plugins](#plugins)
- [Agent Runtime](#agent-runtime)
- [Session, memory, and context engine](#session-memory-and-context-engine)
- [Channel framework](#channel-framework)
- [Security, auth, pairing, and secrets](#security-auth-pairing-and-secrets)
- [Observability](#observability)
- [Automation: cron, hooks, tasks, polling](#automation-cron-hooks-tasks-polling)
- [Media understanding and media generation](#media-understanding-and-media-generation)
- [Voice and realtime talk](#voice-and-realtime-talk)
- [Gateway Web App](#gateway-web-app)
- [TUI](#tui)
- [ClawHub](#clawhub)
- [OpenClaw App SDK](#openclaw-app-sdk)

### Platform

- [macOS Gateway host](#macos-gateway-host)
- [macOS companion app](#macos-companion-app)
- [Linux Gateway host](#linux-gateway-host)
- [Linux companion app](#linux-companion-app)
- [Windows via WSL2](#windows-via-wsl2)
- [Native Windows](#native-windows)
- [Native Windows companion app](#native-windows-companion-app)
- [Android app](#android-app)
- [iOS app](#ios-app)
- [watchOS companion surfaces](#watchos-companion-surfaces)
- [Raspberry Pi and small Linux devices](#raspberry-pi-and-small-linux-devices)
- [Docker and Podman hosting](#docker-and-podman-hosting)
- [Kubernetes hosting](#kubernetes-hosting)
- [Nix install path](#nix-install-path)

### Channel

- [Discord](#discord)
- [Telegram](#telegram)
- [WhatsApp](#whatsapp)
- [Slack](#slack)
- [iMessage and BlueBubbles](#imessage-and-bluebubbles)
- [Signal](#signal)
- [Google Chat](#google-chat)
- [Matrix](#matrix)
- [Microsoft Teams](#microsoft-teams)
- [Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat](#mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat)
- [Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels](#feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels)
- [Voice Call channel](#voice-call-channel)

### Provider and tool

- [OpenAI and Codex provider path](#openai-and-codex-provider-path)
- [Anthropic provider path](#anthropic-provider-path)
- [Google provider path](#google-provider-path)
- [OpenRouter provider path](#openrouter-provider-path)
- [Local model providers: Ollama, vLLM, SGLang, LM Studio](#local-model-providers-ollama-vllm-sglang-lm-studio)
- [Long-tail hosted providers](#long-tail-hosted-providers)
- [Web search tools](#web-search-tools)
- [Browser automation, exec, and sandbox tools](#browser-automation-exec-and-sandbox-tools)
- [Image, video, and music generation tools](#image-video-and-music-generation-tools)

## Details

### Core

#### Gateway runtime

- Level: M4 Stable
- Rationale: Core architecture, auth, pairing, protocol docs, daemon docs, and CLI runbooks are broad and current.

| Area                            | Capabilities | Docs                                                                                                                                                                                                                                      | Coverage   | Quality        | Completeness   | Long-term support |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Approvals and Remote Execution  | 6            | [Protocol](/gateway/protocol), [Index](/gateway/security/index)                                                                                                                                                                           | `Unscored` | `Beta (72%)`   | `Beta (78%)`   | Yes               |
| HTTP APIs                       | 4            | [Index](/gateway/index), [Openai Http Api](/gateway/openai-http-api), [Openresponses Http Api](/gateway/openresponses-http-api), [Tools Invoke Http Api](/gateway/tools-invoke-http-api), [Hooks](/automation/hooks), [Index](/web/index) | `Unscored` | `Beta (74%)`   | `Beta (72%)`   | Yes               |
| Hosted Web Surface              | 4            | [Index](/gateway/index), [Architecture](/concepts/architecture), [Control Ui](/web/control-ui), [Webchat](/web/webchat), [Canvas](/refactor/canvas)                                                                                       | `Unscored` | `Beta (74%)`   | `Beta (72%)`   | Yes               |
| Gateway RPC APIs and Events     | 20           | [Protocol](/gateway/protocol), [Index](/gateway/index), [Architecture](/concepts/architecture)                                                                                                                                            | `Unscored` | `Alpha (57%)`  | `Stable (88%)` | Yes               |
| Device Auth and Pairing         | 10           | [Protocol](/gateway/protocol), [Pairing](/gateway/pairing), [Index](/gateway/security/index)                                                                                                                                              | `Unscored` | `Beta (72%)`   | `Stable (82%)` | Yes               |
| Network Access and Discovery    | 6            | [Index](/gateway/index), [Discovery](/gateway/discovery), [Protocol](/gateway/protocol)                                                                                                                                                   | `Unscored` | `Alpha (62%)`  | `Beta (74%)`   | Yes               |
| Nodes and Remote Capabilities   | 8            | [Protocol](/gateway/protocol), [Architecture](/concepts/architecture), [Index](/nodes/index)                                                                                                                                              | `Unscored` | `Alpha (63%)`  | `Beta (76%)`   | No                |
| Health, Diagnostics, and Repair | 7            | [Index](/gateway/index), [Diagnostics](/gateway/diagnostics), [Doctor](/gateway/doctor)                                                                                                                                                   | `Unscored` | `Alpha (62%)`  | `Beta (78%)`   | Yes               |
| Protocol Compatibility          | 7            | [Protocol](/gateway/protocol), [Architecture](/concepts/architecture), [Typebox](/concepts/typebox), [Bridge Protocol](/gateway/bridge-protocol)                                                                                          | `Unscored` | `Beta (70%)`   | `Stable (84%)` | Yes               |
| Roles and Permissions           | 5            | [Protocol](/gateway/protocol), [Index](/gateway/security/index)                                                                                                                                                                           | `Unscored` | `Alpha (62%)`  | `Stable (80%)` | Yes               |
| Gateway Lifecycle               | 7            | [Index](/gateway/index), [Architecture](/concepts/architecture)                                                                                                                                                                           | `Unscored` | `Stable (82%)` | `Stable (88%)` | Yes               |
| Security Controls               | 6            | [Index](/gateway/security/index), [Protocol](/gateway/protocol), [Discovery](/gateway/discovery)                                                                                                                                          | `Unscored` | `Beta (74%)`   | `Stable (80%)` | Yes               |
| WebSocket Connection            | 8            | [Protocol](/gateway/protocol), [Architecture](/concepts/architecture)                                                                                                                                                                     | `Unscored` | `Beta (76%)`   | `Stable (82%)` | Yes               |

#### CLI

- Level: M4 Stable
- Rationale: Normal setup and repair paths are documented across install, CLI, and gateway docs. Platform-specific Windows paths are tracked in the Windows via WSL2 and Native Windows rows.

| Area                       | Capabilities | Docs                                                                                                                       | Coverage   | Quality       | Completeness   | Long-term support |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| CLI Setup                  | 6            | [Index](/install/index), [Installer](/install/installer), [Node](/install/node), [Updating](/install/updating)             | `Unscored` | `Beta (75%)`  | `Stable (84%)` | Yes               |
| Onboarding and Auth Setup  | 5            | [Onboard](/cli/onboard), [Configure](/cli/configure), [Onboarding Overview](/start/onboarding-overview)                    | `Unscored` | `Beta (78%)`  | `Stable (80%)` | Yes               |
| Plugin and Channel Setup   | 5            | [Onboard](/cli/onboard), [Plugins](/cli/plugins), [Channels](/cli/channels)                                                | `Unscored` | `Beta (72%)`  | `Beta (76%)`   | No                |
| Gateway Service Management | 5            | [Gateway](/cli/gateway), [Updating](/install/updating), [Troubleshooting](/gateway/troubleshooting)                        | `Unscored` | `Alpha (66%)` | `Stable (84%)` | Yes               |
| CLI Observability          | 5            | [Status](/cli/status), [Health](/cli/health), [Logs](/cli/logs), [Diagnostics](/gateway/diagnostics)                       | `Unscored` | `Beta (74%)`  | `Stable (84%)` | Yes               |
| Doctor                     | 10           | [Doctor](/cli/doctor), [Doctor](/gateway/doctor), [Secrets](/gateway/secrets), [Troubleshooting](/gateway/troubleshooting) | `Unscored` | `Alpha (68%)` | `Beta (77%)`   | Yes               |
| Updates and Upgrades       | 5            | [Updating](/install/updating), [Update](/cli/update), [Troubleshooting](/gateway/troubleshooting)                          | `Unscored` | `Alpha (68%)` | `Beta (78%)`   | Yes               |

#### Plugins

- Level: M3 Beta
- Rationale: Broad docs and strong internal runtime evidence exist across manifests, discovery, loading, provider/tool architecture, and approval boundaries. Keep the row at beta until public SDK API/subpaths and external distribution proof are stronger.

| Area                            | Capabilities | Docs                                                                                                                                                                                                                                     | Coverage   | Quality        | Completeness   | Long-term support |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Authoring and Packaging plugins | 8            | [Building Plugins](/plugins/building-plugins), [Sdk Overview](/plugins/sdk-overview), [Sdk Entrypoints](/plugins/sdk-entrypoints), [Sdk Subpaths](/plugins/sdk-subpaths), [Manifest](/plugins/manifest), [Reference](/plugins/reference) | `Unscored` | `Beta (74%)`   | `Beta (72%)`   | Yes               |
| Bundled plugins                 | 5            | [Plugin Inventory](/plugins/plugin-inventory), [Plugins](/cli/plugins), [Architecture Internals](/plugins/architecture-internals)                                                                                                        | `Unscored` | `Stable (84%)` | `Stable (88%)` | Yes               |
| Canvas plugin                   | 6            | [Canvas](/plugins/reference/canvas), [Canvas](/refactor/canvas), [Configuration Reference](/gateway/configuration-reference)                                                                                                             | `Unscored` | `Alpha (66%)`  | `Beta (74%)`   | No                |
| Installing and running plugins  | 6            | [Architecture](/plugins/architecture), [Architecture Internals](/plugins/architecture-internals), [Plugins](/cli/plugins)                                                                                                                | `Unscored` | `Stable (84%)` | `Stable (88%)` | Yes               |
| Channel plugins                 | 5            | [Sdk Channel Plugins](/plugins/sdk-channel-plugins), [Sdk Channel Inbound](/plugins/sdk-channel-inbound), [Sdk Channel Outbound](/plugins/sdk-channel-outbound)                                                                          | `Unscored` | `Beta (78%)`   | `Stable (80%)` | Yes               |
| Provider and tool plugins       | 6            | [Sdk Provider Plugins](/plugins/sdk-provider-plugins), [Tool Plugins](/plugins/tool-plugins), [Adding Capabilities](/plugins/adding-capabilities)                                                                                        | `Unscored` | `Stable (82%)` | `Stable (84%)` | Yes               |
| Plugin approvals                | 6            | [Plugin Permission Requests](/plugins/plugin-permission-requests), [Exec Approvals](/tools/exec-approvals), [Sdk Channel Plugins](/plugins/sdk-channel-plugins)                                                                          | `Unscored` | `Stable (86%)` | `Stable (86%)` | Yes               |
| Publishing plugins              | 6            | [Plugins](/cli/plugins), [Compatibility](/plugins/compatibility), [Publishing](/clawhub/publishing)                                                                                                                                      | `Unscored` | `Stable (82%)` | `Beta (74%)`   | Yes               |
| Testing plugins                 | 6            | [Sdk Testing](/plugins/sdk-testing), [Sdk Setup](/plugins/sdk-setup), [Codex Harness](/plugins/codex-harness)                                                                                                                            | `Unscored` | `Stable (81%)` | `Stable (82%)` | No                |

#### Agent Runtime

- Level: M3 Beta
- Rationale: Main loop, models, provider routing, and tool streaming are first-class, but provider behavior shifts weekly and needs scenario proof per release.

| Area                             | Capabilities | Docs                                                                                                                                                                                               | Coverage   | Quality       | Completeness   | Long-term support |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Agent Turn Execution             | 3            | [Agent Loop](/concepts/agent-loop), [Agent](/cli/agent), [Agent Runtimes](/concepts/agent-runtimes)                                                                                                | `Unscored` | `Beta (74%)`  | `Stable (82%)` | Yes               |
| External Runtimes and Subagents  | 4            | [Agent Runtimes](/concepts/agent-runtimes), [Anthropic](/providers/anthropic), [Google](/providers/google), [Subagents](/tools/subagents)                                                          | `Unscored` | `Alpha (66%)` | `Beta (78%)`   | No                |
| Hosted Provider Execution        | 5            | [Openai](/providers/openai), [Anthropic](/providers/anthropic), [Google](/providers/google), [Models](/concepts/models)                                                                            | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | Yes               |
| Local and Self-hosted Providers  | 5            | [Ollama](/providers/ollama), [Models](/concepts/models), [Agent](/cli/agent)                                                                                                                       | `Unscored` | `Alpha (60%)` | `Beta (70%)`   | No                |
| Model and Runtime Selection      | 4            | [Models](/concepts/models), [Models](/cli/models), [Openai](/providers/openai), [Agent Runtimes](/concepts/agent-runtimes)                                                                         | `Unscored` | `Beta (72%)`  | `Stable (84%)` | Yes               |
| Provider Auth                    | 10           | [Models](/concepts/models), [Agent](/cli/agent), [Models](/cli/models), [Openai](/providers/openai), [Anthropic](/providers/anthropic), [Google](/providers/google), [Subagents](/tools/subagents) | `Unscored` | `Alpha (66%)` | `Stable (80%)` | Yes               |
| Streaming and Progress           | 2            | [Streaming](/concepts/streaming), [Agent Loop](/concepts/agent-loop)                                                                                                                               | `Unscored` | `Beta (70%)`  | `Stable (84%)` | No                |
| Tool Calls and Response Handling | 3            | [Agent Loop](/concepts/agent-loop), [Ollama](/providers/ollama)                                                                                                                                    | `Unscored` | `Alpha (66%)` | `Stable (80%)` | Yes               |
| Tool Execution Controls          | 6            | [Sandbox Vs Tool Policy Vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated), [Agent Loop](/concepts/agent-loop), [Subagents](/tools/subagents)                                               | `Unscored` | `Beta (74%)`  | `Stable (86%)` | Yes               |

#### Session, memory, and context engine

- Level: M3 Beta
- Rationale: Strong docs and active implementation. Maturity depends on transcript durability, compaction quality, and cross-client parity.

| Area                                    | Capabilities | Docs                                                                                                                                         | Coverage   | Quality        | Completeness   | Long-term support |
| --------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| CLI Session and Transcript Management   | 2            | [Session](/concepts/session), [Session Management Compaction](/reference/session-management-compaction), [Sessions](/cli/sessions)           | `Unscored` | `Alpha (68%)`  | `Beta (74%)`   | Yes               |
| Token Management                        | 3            | [Compaction](/concepts/compaction), [Context](/concepts/context), [Session Management Compaction](/reference/session-management-compaction)  | `Unscored` | `Alpha (60%)`  | `Beta (78%)`   | Yes               |
| Context Engine                          | 2            | [Context](/concepts/context), [Context Engine](/concepts/context-engine), [Codex Context Engine Harness](/plan/codex-context-engine-harness) | `Unscored` | `Stable (80%)` | `Beta (72%)`   | Yes               |
| Cross-client History and Session Parity | 2            | [Webchat](/web/webchat), [Android](/platforms/android), [Channel Routing](/channels/channel-routing)                                         | `Unscored` | `Alpha (62%)`  | `Beta (76%)`   | No                |
| Diagnostics, Maintenance, and Recovery  | 3            | [Diagnostics](/gateway/diagnostics), [Session Management Compaction](/reference/session-management-compaction), [Flags](/diagnostics/flags)  | `Unscored` | `Alpha (68%)`  | `Beta (72%)`   | No                |
| Core Prompts and Context                | 2            | [Context](/concepts/context), [Transcript Hygiene](/reference/transcript-hygiene), [Discord](/channels/discord)                              | `Unscored` | `Beta (70%)`   | `Alpha (68%)`  | Yes               |
| Memory                                  | 5            | [Memory Config](/reference/memory-config), [Memory Qmd](/concepts/memory-qmd), [Memory](/concepts/memory), [Discord](/channels/discord)      | `Unscored` | `Alpha (58%)`  | `Alpha (66%)`  | No                |
| Session Routing                         | 2            | [Session](/concepts/session), [Channel Routing](/channels/channel-routing), [Discord](/channels/discord)                                     | `Unscored` | `Beta (74%)`   | `Stable (82%)` | Yes               |
| Transcript Persistence                  | 2            | [Session Management Compaction](/reference/session-management-compaction), [Transcript Hygiene](/reference/transcript-hygiene)               | `Unscored` | `Alpha (58%)`  | `Beta (78%)`   | Yes               |

#### Channel framework

- Level: M3 Beta
- Rationale: Many channels share Gateway delivery and routing contracts, but channel behavior varies by upstream API and account-policy constraints.

| Area                                    | Capabilities | Docs                                                                                                                                                                                                                                          | Coverage   | Quality       | Completeness   | Long-term support |
| --------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Channel Actions Commands and Approvals  | 5            | [Groups](/channels/groups), [Discord](/channels/discord), [Googlechat](/channels/googlechat), [Signal](/channels/signal), [Matrix](/channels/matrix)                                                                                          | `Unscored` | `Beta (72%)`  | `Alpha (68%)`  | No                |
| Channel Setup                           | 5            | [Index](/channels/index), [Pairing](/channels/pairing), [Troubleshooting](/channels/troubleshooting), [Sdk Channel Plugins](/plugins/sdk-channel-plugins)                                                                                     | `Unscored` | `Beta (78%)`  | `Stable (84%)` | Yes               |
| Group Thread and Ambient Room Behavior  | 5            | [Groups](/channels/groups), [Group Messages](/channels/group-messages), [Ambient Room Events](/channels/ambient-room-events), [Broadcast Groups](/channels/broadcast-groups), [Discord](/channels/discord)                                    | `Unscored` | `Alpha (68%)` | `Beta (72%)`   | No                |
| Inbound Access and Identity Gates       | 5            | [Access Groups](/channels/access-groups), [Groups](/channels/groups), [Discord](/channels/discord), [Line](/channels/line)                                                                                                                    | `Unscored` | `Beta (76%)`  | `Stable (80%)` | Yes               |
| Media Attachments and Rich Channel Data | 4            | [Line](/channels/line), [Signal](/channels/signal), [Googlechat](/channels/googlechat), [Matrix](/channels/matrix), [Discord](/channels/discord)                                                                                              | `Unscored` | `Beta (70%)`  | `Alpha (68%)`  | No                |
| Outbound Delivery and Reply Pipeline    | 4            | [Groups](/channels/groups), [Ambient Room Events](/channels/ambient-room-events), [Discord](/channels/discord), [Matrix](/channels/matrix), [Config Channels](/gateway/config-channels)                                                       | `Unscored` | `Beta (75%)`  | `Stable (82%)` | Yes               |
| Conversation Routing and Delivery       | 10           | [Channel Routing](/channels/channel-routing), [Groups](/channels/groups), [Discord](/channels/discord), [Matrix](/channels/matrix), [Troubleshooting](/channels/troubleshooting), [Configuration Reference](/gateway/configuration-reference) | `Unscored` | `Beta (71%)`  | `Beta (77%)`   | Yes               |
| Status Health and Operator Controls     | 4            | [Health](/gateway/health), [Configuration Reference](/gateway/configuration-reference), [Troubleshooting](/channels/troubleshooting), [Discord](/channels/discord)                                                                            | `Unscored` | `Beta (78%)`  | `Stable (82%)` | Yes               |

#### Security, auth, pairing, and secrets

- Level: M3 Beta
- Rationale: Good docs and hardening surfaces exist. Promote after regular upgrade/security scenario runs prove no setup regressions.

| Area                                | Capabilities | Docs                                                                                                                                                                                                                                                                                                                                                                                                                                           | Coverage   | Quality       | Completeness   | Long-term support |
| ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Approval Policy and Tool Safeguards | 2            | [Exec Approvals](/tools/exec-approvals), [Approvals](/cli/approvals), [Plugin Permission Requests](/plugins/plugin-permission-requests), [Audit Checks](/gateway/security/audit-checks)                                                                                                                                                                                                                                                        | `Unscored` | `Beta (72%)`  | `Stable (86%)` | Yes               |
| Gateway Auth and Remote Access      | 9            | [Index](/gateway/security/index), [Exposure Runbook](/gateway/security/exposure-runbook), [Trusted Proxy Auth](/gateway/trusted-proxy-auth), [Tailscale](/gateway/tailscale), [Remote](/gateway/remote), [Configuration Reference](/gateway/configuration-reference), [Gateway](/cli/gateway), [Doctor](/cli/doctor), [Control Ui](/web/control-ui), [Browser Control](/tools/browser-control), [Audit Checks](/gateway/security/audit-checks) | `Unscored` | `Alpha (68%)` | `Stable (82%)` | Yes               |
| Channel Access Control              | 3            | [Pairing](/channels/pairing), [Telegram](/channels/telegram), [Access Groups](/channels/access-groups), [Audit Checks](/gateway/security/audit-checks)                                                                                                                                                                                                                                                                                         | `Unscored` | `Alpha (66%)` | `Beta (78%)`   | Yes               |
| Device and Node Pairing             | 11           | [Protocol](/gateway/protocol), [Devices](/cli/devices), [Pairing](/channels/pairing), [Pairing](/gateway/pairing), [Operator Scopes](/gateway/operator-scopes), [Control Ui](/web/control-ui), [Webchat](/web/webchat), [Approvals](/cli/approvals)                                                                                                                                                                                            | `Unscored` | `Alpha (66%)` | `Stable (83%)` | Yes               |
| Plugin Trust                        | 2            | [Manifest](/plugins/manifest), [Plugin Permission Requests](/plugins/plugin-permission-requests), [Manage Plugins](/plugins/manage-plugins), [Audit Checks](/gateway/security/audit-checks)                                                                                                                                                                                                                                                    | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | No                |
| Credential and Secret Hygiene       | 5            | [Authentication](/gateway/authentication), [Models](/cli/models), [Openai](/providers/openai), [Oauth](/concepts/oauth), [Secrets](/gateway/secrets), [Secrets](/cli/secrets), [Secretref Credential Surface](/reference/secretref-credential-surface), [Audit Checks](/gateway/security/audit-checks)                                                                                                                                         | `Unscored` | `Alpha (62%)` | `Beta (78%)`   | Yes               |

#### Observability

- Level: M3 Beta
- Rationale: OTel, Prometheus, logging, and diagnostics docs exist. Needs a public "what operators should look at first" maturity pass.

| Area                  | Capabilities | Docs                                                                                                                                                                                                                                                                                          | Coverage   | Quality        | Completeness   | Long-term support |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Health and Repair     | 12           | [Health](/gateway/health), [Telegram](/channels/telegram), [Doctor](/cli/doctor), [Doctor](/gateway/doctor), [Sdk Subpaths](/plugins/sdk-subpaths), [Health](/cli/health), [Protocol](/gateway/protocol)                                                                                      | `Unscored` | `Beta (76%)`   | `Stable (80%)` | Yes               |
| Logging               | 5            | [Logging](/logging), [Logging](/gateway/logging), [Logs](/cli/logs)                                                                                                                                                                                                                           | `Unscored` | `Stable (84%)` | `Stable (82%)` | Yes               |
| Diagnostic Collection | 8            | [Diagnostics](/gateway/diagnostics), [Health](/gateway/health), [Codex Harness](/plugins/codex-harness), [Protocol](/gateway/protocol)                                                                                                                                                        | `Unscored` | `Beta (74%)`   | `Beta (76%)`   | No                |
| Telemetry Export      | 13           | [Hooks](/plugins/hooks), [Opentelemetry](/gateway/opentelemetry), [Logging](/logging), [Sdk Subpaths](/plugins/sdk-subpaths), [Diagnostics Otel](/plugins/reference/diagnostics-otel), [Prometheus](/gateway/prometheus), [Diagnostics Prometheus](/plugins/reference/diagnostics-prometheus) | `Unscored` | `Beta (78%)`   | `Beta (78%)`   | No                |
| Session Diagnostics   | 4            | [Opentelemetry](/gateway/opentelemetry), [Prometheus](/gateway/prometheus), [Diagnostics](/gateway/diagnostics), [Protocol](/gateway/protocol)                                                                                                                                                | `Unscored` | `Beta (78%)`   | `Stable (82%)` | Yes               |

#### Automation: cron, hooks, tasks, polling

- Level: M3 Beta
- Rationale: Documented and usable, but scenario proof should cover unattended delivery, retries, and failure visibility.

| Area                       | Capabilities | Docs                                                                                                                                                                                                                                                                                                                                                                                                | Coverage   | Quality       | Completeness   | Long-term support |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Cron Jobs                  | 15           | [Cron Jobs](/automation/cron-jobs), [Cron](/cli/cron), [Protocol](/gateway/protocol), [Tasks](/automation/tasks), [Discord](/channels/discord)                                                                                                                                                                                                                                                      | `Unscored` | `Beta (73%)`  | `Stable (82%)` | No                |
| Event Ingress              | 15           | [Telegram](/channels/telegram), [Zalo](/channels/zalo), [Troubleshooting](/channels/troubleshooting), [Imessage From Bluebubbles](/channels/imessage-from-bluebubbles), [Gmail Pubsub Integration](/automation/cron-jobs#gmail-pubsub-integration), [Gmail Pubsub](/automation/gmail-pubsub), [Webhooks](/cli/webhooks), [Webhooks](/automation/cron-jobs#webhooks), [Webhook](/automation/webhook) | `Unscored` | `Alpha (58%)` | `Alpha (65%)`  | No                |
| Automation Hooks           | 11           | [Hooks](/automation/hooks), [Hooks](/cli/hooks), [Hooks](/plugins/hooks), [Plugin Permission Requests](/plugins/plugin-permission-requests), [Sdk Subpaths](/plugins/sdk-subpaths)                                                                                                                                                                                                                  | `Unscored` | `Beta (72%)`  | `Beta (78%)`   | No                |
| Background Tasks and Flows | 10           | [Tasks](/automation/tasks), [Index](/automation/index), [Tasks](/cli/tasks), [Taskflow](/automation/taskflow), [Sdk Runtime](/plugins/sdk-runtime)                                                                                                                                                                                                                                                  | `Unscored` | `Alpha (68%)` | `Beta (73%)`   | No                |
| Heartbeat                  | 5            | [Index](/automation/index), [Heartbeat](/gateway/heartbeat), [Commitments](/concepts/commitments)                                                                                                                                                                                                                                                                                                   | `Unscored` | `Beta (72%)`  | `Stable (82%)` | No                |
| Polling Controls           | 10           | [Poll](/automation/poll), [Message](/cli/message), [Telegram](/channels/telegram), [Msteams](/channels/msteams), [Background Process](/gateway/background-process)                                                                                                                                                                                                                                  | `Unscored` | `Beta (70%)`  | `Beta (74%)`   | No                |

#### Media understanding and media generation

- Level: M2 Alpha
- Rationale: Broad capability surface exists, but provider variance, file limits, and node/app parity make this not stable yet.

| Area                    | Capabilities | Docs                                                                                                                                                                                                                                                                                                  | Coverage   | Quality       | Completeness   | Long-term support |
| ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Media Intake and Access | 8            | [Media Overview](/tools/media-overview), [Media Understanding](/nodes/media-understanding), [Secure File Operations](/gateway/security/secure-file-operations), [Pdf](/tools/pdf), [Image Generation](/tools/image-generation), [Qr](/cli/qr), [Line](/channels/line), [Whatsapp](/channels/whatsapp) | `Unscored` | `Beta (76%)`  | `Beta (74%)`   | No                |
| Channel Media Handling  | 5            | [Images](/nodes/images), [Media Overview](/tools/media-overview), [Discord](/channels/discord)                                                                                                                                                                                                        | `Unscored` | `Alpha (68%)` | `Stable (84%)` | No                |
| Media Configuration     | 1            | [Media Overview](/tools/media-overview), [Image Generation](/tools/image-generation), [Manifest](/plugins/manifest), [Codex Harness](/plugins/codex-harness)                                                                                                                                          | `Unscored` | `Beta (77%)`  | `Stable (82%)` | No                |
| Text-to-Speech Delivery | 2            | [Tts](/tools/tts), [Media Overview](/tools/media-overview), [Discord](/channels/discord)                                                                                                                                                                                                              | `Unscored` | `Beta (70%)`  | `Stable (84%)` | No                |
| Media Understanding     | 12           | [Audio](/nodes/audio), [Media Understanding](/nodes/media-understanding), [Media Overview](/tools/media-overview), [Whatsapp](/channels/whatsapp), [Images](/nodes/images), [Infer](/cli/infer), [Pdf](/tools/pdf)                                                                                    | `Unscored` | `Alpha (62%)` | `Beta (72%)`   | No                |
| Media Generation        | 17           | [Image Generation](/tools/image-generation), [Media Overview](/tools/media-overview), [Skills](/tools/skills), [Music Generation](/tools/music-generation), [Video Generation](/tools/video-generation)                                                                                               | `Unscored` | `Alpha (64%)` | `Beta (74%)`   | No                |

#### Voice and realtime talk

- Level: M2 Alpha
- Rationale: Multiple implementations exist across Control UI, apps, and providers. Needs latency, failure-mode, and setup scorecards before beta.

| Area                     | Capabilities | Docs                                                                                                                                                                | Coverage   | Quality       | Completeness  | Long-term support |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Talk Providers           | 7            | [Openai](/providers/openai), [Google](/providers/google), [Sdk Provider Plugins](/plugins/sdk-provider-plugins), [Talk](/nodes/talk), [Control Ui](/web/control-ui) | `Unscored` | `Alpha (68%)` | `Beta (74%)`  | No                |
| Realtime Talk Sessions   | 11           | [Talk](/nodes/talk), [Control Ui](/web/control-ui)                                                                                                                  | `Unscored` | `Alpha (68%)` | `Beta (72%)`  | No                |
| Speech and Transcription | 5            | [Talk](/nodes/talk), [Openai](/providers/openai), [Google](/providers/google)                                                                                       | `Unscored` | `Alpha (68%)` | `Beta (72%)`  | No                |
| Native App Talk          | 4            | [Talk](/nodes/talk), [Voicewake](/platforms/mac/voicewake)                                                                                                          | `Unscored` | `Alpha (64%)` | `Alpha (68%)` | No                |
| Voice Wake and Routing   | 4            | [Voicewake](/nodes/voicewake), [Voicewake](/platforms/mac/voicewake), [Voice Overlay](/platforms/mac/voice-overlay)                                                 | `Unscored` | `Alpha (66%)` | `Beta (74%)`  | No                |
| Talk Observability       | 5            | [Control Ui](/web/control-ui), [Voice Overlay](/platforms/mac/voice-overlay), [Talk](/nodes/talk)                                                                   | `Unscored` | `Beta (70%)`  | `Beta (76%)`  | No                |

#### Gateway Web App

- Level: M3 Beta
- Rationale: Web UI is documented with pairing, chat, PWA, Talk, push, and remote Gateway flows. Promote after cross-browser and mobile-PWA scorecards.

| Area                     | Capabilities | Docs                                                                                                                                                                                                                | Coverage   | Quality       | Completeness   | Long-term support |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Browser Realtime Talk    | 5            | [Control Ui](/web/control-ui), [Protocol](/gateway/protocol), [Talk](/nodes/talk)                                                                                                                                   | `Unscored` | `Beta (70%)`  | `Beta (78%)`   | No                |
| Browser Access and Trust | 5            | [Control Ui](/web/control-ui), [Dashboard](/web/dashboard), [Tailscale](/gateway/tailscale), [Remote](/gateway/remote)                                                                                              | `Unscored` | `Alpha (68%)` | `Stable (84%)` | No                |
| Configuration            | 5            | [Control Ui](/web/control-ui), [Configuration](/gateway/configuration)                                                                                                                                              | `Unscored` | `Beta (78%)`  | `Stable (82%)` | No                |
| Browser UI               | 10           | [Control Ui](/web/control-ui), [Index](/web/index), [Dashboard](/web/dashboard), [Protocol](/gateway/protocol)                                                                                                      | `Unscored` | `Beta (72%)`  | `Beta (74%)`   | No                |
| WebChat Conversations    | 15           | [Control Ui](/web/control-ui), [Webchat](/web/webchat), [Getting Started](/start/getting-started), [Channel Routing](/channels/channel-routing), [Secure File Operations](/gateway/security/secure-file-operations) | `Unscored` | `Alpha (66%)` | `Beta (78%)`   | No                |
| Operator Console         | 10           | [Control Ui](/web/control-ui), [Health](/gateway/health), [Protocol](/gateway/protocol), [Dashboard](/web/dashboard)                                                                                                | `Unscored` | `Beta (74%)`  | `Beta (78%)`   | No                |

#### TUI

- Level: M2 Alpha
- Rationale: Present in docs and source, but less visible as a primary user workflow. Needs explicit scenario definition.

| Area                        | Capabilities | Docs                                                                             | Coverage   | Quality       | Completeness   | Long-term support |
| --------------------------- | ------------ | -------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Runtime Modes               | 14           | [Tui](/cli/tui), [Tui](/web/tui), [Index](/cli/index)                            | `Unscored` | `Beta (72%)`  | `Beta (78%)`   | No                |
| Input and Commands          | 8            | [Tui](/web/tui)                                                                  | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | No                |
| Session Management          | 3            | [Tui](/web/tui), [Sessions](/cli/sessions)                                       | `Unscored` | `Alpha (68%)` | `Stable (80%)` | No                |
| Local Shell Execution       | 4            | [Tui](/web/tui), [Tui](/cli/tui)                                                 | `Unscored` | `Beta (76%)`  | `Beta (70%)`   | No                |
| Rendering and Output Safety | 4            | [Tui](/web/tui), [Qr](/cli/qr), [Logs](/cli/logs), [Completion](/cli/completion) | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | No                |

#### ClawHub

- Level: M2 Alpha
- Rationale: Public docs and ecosystem concept exist. Needs install, trust, update, rollback, and compatibility scorecards.

| Area                        | Capabilities | Docs                                                                                                                                                                                                                                        | Coverage   | Quality      | Completeness  | Long-term support |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ------------- | ----------------- |
| Publishing                  | 7            | [Publishing](/clawhub/publishing), [Creating Skills](/tools/creating-skills), [Community](/plugins/community)                                                                                                                               | `Unscored` | `Beta (76%)` | `Beta (72%)`  | No                |
| Catalog Discovery           | 5            | [Plugin](/tools/plugin), [Plugins](/cli/plugins), [Skills](/cli/skills), [Skills](/tools/skills), [Community](/plugins/community)                                                                                                           | `Unscored` | `Beta (72%)` | `Alpha (66%)` | No                |
| Compatibility and Trust     | 12           | [Plugin](/tools/plugin), [Plugins](/cli/plugins), [Compatibility](/plugins/compatibility), [Plugin Inventory](/plugins/plugin-inventory), [Publishing](/clawhub/publishing), [Skills](/tools/skills), [Skills Config](/tools/skills-config) | `Unscored` | `Beta (74%)` | `Beta (76%)`  | No                |
| Plugin Lifecycle and Health | 26           | [Plugin](/tools/plugin), [Plugins](/cli/plugins), [Skills](/cli/skills), [Skills](/tools/skills), [Protocol](/gateway/protocol), [Bundles](/plugins/bundles), [Dependency Resolution](/plugins/dependency-resolution)                       | `Unscored` | `Beta (71%)` | `Beta (76%)`  | No                |

#### OpenClaw App SDK

- Level: M2 Alpha
- Rationale: OpenClaw App SDK is a distinct external app contract separate from Gateway runtime and Plugin SDK. Current scoring shows a real `@openclaw/sdk` path with gaps around public packaging, auto-discovery, approvals, helpers, and compatibility.

| Area                 | Capabilities | Docs                                                                                                                                                       | Coverage   | Quality        | Completeness   | Long-term support |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Client API           | 4            | [Openclaw Sdk](/gateway/external-apps), [Openclaw Sdk Api Design](/gateway/external-apps)                                                                  | `Unscored` | `Stable (82%)` | `Beta (78%)`   | No                |
| Gateway Access       | 5            | [Openclaw Sdk](/gateway/external-apps), [Openclaw Sdk Api Design](/gateway/external-apps), [Protocol](/gateway/protocol), [Index](/gateway/security/index) | `Unscored` | `Beta (74%)`   | `Alpha (64%)`  | No                |
| Agent Conversations  | 6            | [Openclaw Sdk](/gateway/external-apps), [Openclaw Sdk Api Design](/gateway/external-apps), [Protocol](/gateway/protocol)                                   | `Unscored` | `Stable (80%)` | `Stable (84%)` | No                |
| Events and Approvals | 5            | [Openclaw Sdk](/gateway/external-apps), [Openclaw Sdk Api Design](/gateway/external-apps), [Protocol](/gateway/protocol)                                   | `Unscored` | `Beta (73%)`   | `Alpha (58%)`  | No                |
| Resource Helpers     | 5            | [Openclaw Sdk](/gateway/external-apps), [Openclaw Sdk Api Design](/gateway/external-apps)                                                                  | `Unscored` | `Beta (72%)`   | `Beta (70%)`   | No                |
| Compatibility        | 5            | [Openclaw Sdk Api Design](/gateway/external-apps), [Typebox](/concepts/typebox), [Protocol](/gateway/protocol)                                             | `Unscored` | `Beta (70%)`   | `Alpha (62%)`  | No                |

### Platform

#### macOS Gateway host

- Level: M4 Stable
- Rationale: LaunchAgent service path, local/remote Gateway modes, CLI install, and app integration are documented.

| Area                                | Capabilities | Docs                                                                                                                                                                                                                                                               | Coverage   | Quality        | Completeness   | Long-term support |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------- | -------------- | ----------------- |
| CLI Setup                           | 4            | [Macos](/platforms/macos), [Bundled Gateway](/platforms/mac/bundled-gateway), [Installer](/install/installer), [Node](/install/node)                                                                                                                               | `Unscored` | `Beta (76%)`   | `Stable (82%)` | No                |
| Local Gateway Integration           | 9            | [Macos](/platforms/macos), [Bundled Gateway](/platforms/mac/bundled-gateway), [Remote](/platforms/mac/remote), [Index](/gateway/index), [Gateway](/cli/gateway), [Bonjour](/gateway/bonjour)                                                                       | `Unscored` | `Stable (82%)` | `Beta (76%)`   | No                |
| Remote Gateway Mode                 | 5            | [Remote](/platforms/mac/remote), [Remote](/gateway/remote), [Tailscale](/gateway/tailscale)                                                                                                                                                                        | `Unscored` | `Stable (82%)` | `Beta (72%)`   | No                |
| Gateway Service Lifecycle           | 10           | [Macos](/platforms/macos), [Bundled Gateway](/platforms/mac/bundled-gateway), [Gateway](/cli/gateway), [Index](/gateway/index), [Update](/cli/update), [Updating](/install/updating), [Uninstall](/install/uninstall), [Troubleshooting](/gateway/troubleshooting) | `Unscored` | `Beta (76%)`   | `Stable (82%)` | No                |
| Diagnostics and Observability       | 4            | [Bundled Gateway](/platforms/mac/bundled-gateway), [Macos](/platforms/macos), [Gateway](/cli/gateway), [Doctor](/gateway/doctor), [Troubleshooting](/gateway/troubleshooting)                                                                                      | `Unscored` | `Stable (83%)` | `Stable (80%)` | No                |
| Permissions and Native Capabilities | 4            | [Macos](/platforms/macos), [Remote](/platforms/mac/remote)                                                                                                                                                                                                         | `Unscored` | `Beta (73%)`   | `Alpha (62%)`  | No                |
| Profiles and Isolation              | 5            | [Multiple Gateways](/gateway/multiple-gateways), [Index](/gateway/index), [Gateway](/cli/gateway)                                                                                                                                                                  | `Unscored` | `Stable (82%)` | `Beta (74%)`   | No                |

#### macOS companion app

- Level: M3 Beta
- Rationale: Rich menu bar app, permissions, node mode, Canvas, voice wake, WebChat, and remote mode exist. Still fast-moving enough to avoid Stable.

| Area                | Capabilities | Docs                                                                                                                                                                                             | Coverage   | Quality       | Completeness  | Long-term support |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------- | ------------- | ----------------- |
| Canvas              | 4            | [Canvas](/platforms/mac/canvas), [Macos](/platforms/macos), [Webchat](/web/webchat)                                                                                                              | `Unscored` | `Alpha (66%)` | `Beta (74%)`  | No                |
| Local Setup         | 7            | [Bundled Gateway](/platforms/mac/bundled-gateway), [Macos](/platforms/macos), [Child Process](/platforms/mac/child-process), [Dev Setup](/platforms/mac/dev-setup)                               | `Unscored` | `Alpha (65%)` | `Beta (72%)`  | No                |
| Status and Settings | 5            | [Menu Bar](/platforms/mac/menu-bar), [Icon](/platforms/mac/icon), [Macos](/platforms/macos), [Health](/platforms/mac/health), [Logging](/platforms/mac/logging), [Remote](/platforms/mac/remote) | `Unscored` | `Beta (72%)`  | `Beta (70%)`  | No                |
| Native Capabilities | 5            | [Macos](/platforms/macos), [Xpc](/platforms/mac/xpc), [Permissions](/platforms/mac/permissions), [Signing](/platforms/mac/signing), [Peekaboo](/platforms/mac/peekaboo)                          | `Unscored` | `Alpha (60%)` | `Alpha (64%)` | No                |
| Remote Connections  | 3            | [Remote](/platforms/mac/remote), [Macos](/platforms/macos), [Remote](/gateway/remote)                                                                                                            | `Unscored` | `Alpha (68%)` | `Beta (72%)`  | No                |
| Voice and Talk      | 3            | [Voicewake](/platforms/mac/voicewake), [Voice Overlay](/platforms/mac/voice-overlay), [Talk](/nodes/talk), [Macos](/platforms/macos)                                                             | `Unscored` | `Alpha (63%)` | `Beta (70%)`  | No                |
| WebChat             | 3            | [Webchat](/platforms/mac/webchat), [Macos](/platforms/macos), [Webchat](/web/webchat)                                                                                                            | `Unscored` | `Alpha (62%)` | `Beta (72%)`  | No                |
| Remote WebChat      | 5            | [Webchat](/platforms/mac/webchat), [Remote](/gateway/remote), [Remote](/platforms/mac/remote)                                                                                                    | `Unscored` | `Beta (76%)`  | `Beta (74%)`  | No                |

#### Linux Gateway host

- Level: M4 Stable
- Rationale: Node runtime is recommended, systemd user service is documented, and VPS/container guidance is broad.

| Area                                | Capabilities | Docs                                                                                                                                                                                       | Coverage   | Quality      | Completeness   | Long-term support |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------ | -------------- | ----------------- |
| Host Setup and Updates              | 4            | [Index](/install/index), [Updating](/install/updating), [Linux](/platforms/linux), [Index](/platforms/index)                                                                               | `Unscored` | `Beta (78%)` | `Stable (82%)` | Yes               |
| Gateway Runtime and Service Control | 6            | [Index](/gateway/index), [Gateway](/cli/gateway), [Linux](/platforms/linux), [Vps](/vps)                                                                                                   | `Unscored` | `Beta (78%)` | `Stable (83%)` | Yes               |
| Remote Access and Security          | 6            | [Remote](/gateway/remote), [Tailscale](/gateway/tailscale), [Exposure Runbook](/gateway/security/exposure-runbook), [Authentication](/gateway/authentication), [Secrets](/gateway/secrets) | `Unscored` | `Beta (74%)` | `Beta (78%)`   | Yes               |
| Diagnostics and Repair              | 4            | [Status](/cli/status), [Logs](/cli/logs), [Doctor](/cli/doctor), [Diagnostics](/gateway/diagnostics), [Index](/gateway/index)                                                              | `Unscored` | `Beta (78%)` | `Stable (82%)` | Yes               |
| Deployment Targets                  | 3            | [Vps](/vps), [Docker](/install/docker), [Hetzner](/install/hetzner), [Digitalocean](/install/digitalocean), [Kubernetes](/install/kubernetes), [Podman](/install/podman)                   | `Unscored` | `Beta (72%)` | `Beta (76%)`   | No                |

#### Linux companion app

- Level: M0 Planned
- Rationale: Docs say native Linux companion apps are planned; Gateway is the supported Linux path today.

| Area                   | Capabilities | Docs                                                                                                                                                                                      | Coverage   | Quality              | Completeness         | Long-term support |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------- | -------------------- | ----------------- |
| App Distribution       | 3            | [Linux](/platforms/linux), [Index](/platforms/index), [Index](/install/index)                                                                                                             | `Unscored` | `Experimental (18%)` | `Experimental (0%)`  | No                |
| Gateway Connectivity   | 4            | [Linux](/platforms/linux), [Index](/gateway/index), [Pairing](/gateway/pairing), [Remote](/gateway/remote)                                                                                | `Unscored` | `Experimental (35%)` | `Experimental (8%)`  | No                |
| Chat and Sessions      | 3            | [Linux](/platforms/linux), [Protocol](/gateway/protocol), [Webchat](/web/webchat)                                                                                                         | `Unscored` | `Experimental (36%)` | `Experimental (10%)` | No                |
| Desktop Capabilities   | 9            | [Linux](/platforms/linux), [Exec Approvals](/tools/exec-approvals), [Secrets](/gateway/secrets), [Index](/nodes/index), [Exec](/tools/exec), [Talk](/nodes/talk), [Camera](/nodes/camera) | `Unscored` | `Experimental (20%)` | `Experimental (0%)`  | No                |
| Status and Diagnostics | 7            | [Linux](/platforms/linux), [Openclaw](/start/openclaw), [Doctor](/gateway/doctor)                                                                                                         | `Unscored` | `Experimental (25%)` | `Experimental (5%)`  | No                |

#### Windows via WSL2

- Level: M3 Beta
- Rationale: Recommended Windows path with systemd/user-service guidance and boot-chain docs. Promote after repeated install/update scorecards.

| Area                        | Capabilities | Docs                                                                                                                                                                                              | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| WSL Setup                   | 6            | [Windows](/platforms/windows), [Getting Started](/start/getting-started)                                                                                                                          | `Unscored` | `Beta (70%)`  | `Beta (76%)`  | Yes               |
| CLI                         | 8            | [Windows](/platforms/windows), [Getting Started](/start/getting-started), [Updating](/install/updating), [Onboard](/cli/onboard), [Doctor](/cli/doctor), [Status](/cli/status), [Logs](/cli/logs) | `Unscored` | `Beta (70%)`  | `Beta (76%)`  | Yes               |
| Gateway Service Lifecycle   | 10           | [Windows](/platforms/windows), [Index](/gateway/index), [Doctor](/gateway/doctor)                                                                                                                 | `Unscored` | `Alpha (66%)` | `Alpha (64%)` | Yes               |
| Gateway Access and Exposure | 11           | [Authentication](/gateway/authentication), [Secrets](/gateway/secrets), [Remote](/gateway/remote), [Exposure Runbook](/gateway/security/exposure-runbook), [Windows](/platforms/windows)          | `Unscored` | `Alpha (65%)` | `Beta (70%)`  | Yes               |
| Diagnostics and Repair      | 6            | [Windows](/platforms/windows), [Status](/cli/status), [Logs](/cli/logs), [Doctor](/cli/doctor), [Doctor](/gateway/doctor)                                                                         | `Unscored` | `Beta (72%)`  | `Beta (74%)`  | Yes               |
| Browser and Control UI      | 6            | [Browser Wsl2 Windows Remote Cdp Troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting), [Browser](/tools/browser), [Control Ui](/web/control-ui)                               | `Unscored` | `Beta (70%)`  | `Beta (72%)`  | No                |

#### Native Windows

- Level: M2 Alpha
- Rationale: Core CLI/Gateway flows work, but docs still recommend WSL2 for the full experience and list native caveats.

| Area               | Capabilities | Docs                                                                                                                                                        | Coverage   | Quality       | Completeness  | Long-term support |
| ------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| CLI                | 9            | [Index](/install/index), [Installer](/install/installer), [Windows](/platforms/windows), [Getting Started](/start/getting-started), [Onboard](/cli/onboard) | `Unscored` | `Alpha (66%)` | `Beta (72%)`  | Yes               |
| Gateway Management | 11           | [Windows](/platforms/windows), [Index](/gateway/index), [Gateway](/cli/gateway), [Doctor](/cli/doctor)                                                      | `Unscored` | `Alpha (62%)` | `Alpha (68%)` | No                |
| Networking         | 4            | [Windows](/platforms/windows), [Index](/gateway/index), [Gateway](/cli/gateway)                                                                             | `Unscored` | `Alpha (56%)` | `Alpha (58%)` | No                |
| Updates            | 4            | [Updating](/install/updating), [Ci](/ci)                                                                                                                    | `Unscored` | `Alpha (68%)` | `Beta (74%)`  | No                |

#### Native Windows companion app

- Level: M0 Planned
- Rationale: Planned only.

| Area                          | Capabilities | Docs                                                                                                                                                 | Coverage   | Quality              | Completeness        | Long-term support |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------- | ------------------- | ----------------- |
| Installation and Updates      | 4            | [Windows](/platforms/windows), [Index](/install/index)                                                                                               | `Unscored` | `Experimental (25%)` | `Experimental (5%)` | No                |
| Gateway Connection            | 3            | [Windows](/platforms/windows), [Index](/gateway/index), [Pairing](/gateway/pairing), [Remote](/gateway/remote)                                       | `Unscored` | `Experimental (35%)` | `Experimental (8%)` | No                |
| Chat Sessions                 | 2            | [Windows](/platforms/windows), [Protocol](/gateway/protocol)                                                                                         | `Unscored` | `Experimental (25%)` | `Experimental (0%)` | No                |
| Status and Repair             | 5            | [Windows](/platforms/windows), [Doctor](/gateway/doctor), [Index](/gateway/index)                                                                    | `Unscored` | `Experimental (35%)` | `Experimental (5%)` | No                |
| Desktop Tools and Permissions | 10           | [Windows](/platforms/windows), [Index](/nodes/index), [Exec](/tools/exec), [Exec Approvals](/tools/exec-approvals), [Index](/gateway/security/index) | `Unscored` | `Experimental (28%)` | `Experimental (5%)` | No                |

#### Android app

- Level: M2 Alpha
- Rationale: Public Google Play path exists, but app docs still describe the rebuild as extremely alpha and call out release hardening work.

| Area             | Capabilities | Docs                                                                                                    | Coverage   | Quality       | Completeness  | Long-term support |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Media Capture    | 1            | [Android](/platforms/android), [Camera](/nodes/camera)                                                  | `Unscored` | `Alpha (62%)` | `Alpha (66%)` | No                |
| Mobile Chat      | 1            | [Android](/platforms/android)                                                                           | `Unscored` | `Alpha (66%)` | `Beta (70%)`  | No                |
| Connection Setup | 1            | [Android](/platforms/android), [Bonjour](/gateway/bonjour), [Pairing](/gateway/pairing)                 | `Unscored` | `Alpha (64%)` | `Alpha (68%)` | No                |
| Distribution     | 3            | [Android](/platforms/android)                                                                           | `Unscored` | `Alpha (62%)` | `Alpha (60%)` | No                |
| Settings         | 1            | [Android](/platforms/android)                                                                           | `Unscored` | `Alpha (66%)` | `Alpha (64%)` | No                |
| Voice            | 1            | [Android](/platforms/android), [Talk](/nodes/talk)                                                      | `Unscored` | `Alpha (60%)` | `Alpha (66%)` | No                |
| Device Runtime   | 2            | [Android](/platforms/android), [Troubleshooting](/nodes/troubleshooting), [Protocol](/gateway/protocol) | `Unscored` | `Alpha (55%)` | `Alpha (62%)` | No                |

#### iOS app

- Level: M1 Experimental
- Rationale: Internal preview / super-alpha. TestFlight and relay-backed push flows exist, but no public distribution yet.

| Area                          | Capabilities | Docs                                                                          | Coverage   | Quality              | Completeness         | Long-term support |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------- | ---------- | -------------------- | -------------------- | ----------------- |
| Media and Sharing             | 1            | [Ios](/platforms/ios), [Camera](/nodes/camera)                                | `Unscored` | `Experimental (45%)` | `Experimental (42%)` | No                |
| Canvas and Screen             | 1            | [Ios](/platforms/ios), [Canvas](/plugins/reference/canvas)                    | `Unscored` | `Experimental (47%)` | `Experimental (44%)` | No                |
| Chat and Sessions             | 1            | [Ios](/platforms/ios), [Webchat](/web/webchat), [Protocol](/gateway/protocol) | `Unscored` | `Experimental (44%)` | `Experimental (40%)` | No                |
| Gateway Setup and Diagnostics | 7            | [Ios](/platforms/ios), [Pairing](/channels/pairing)                           | `Unscored` | `Experimental (47%)` | `Experimental (41%)` | No                |
| Distribution                  | 1            | [Ios](/platforms/ios)                                                         | `Unscored` | `Experimental (45%)` | `Experimental (42%)` | No                |
| Device Commands               | 2            | [Ios](/platforms/ios), [Protocol](/gateway/protocol)                          | `Unscored` | `Experimental (45%)` | `Experimental (37%)` | No                |
| Notifications and Background  | 1            | [Ios](/platforms/ios), [Configuration](/gateway/configuration)                | `Unscored` | `Experimental (46%)` | `Experimental (44%)` | No                |
| Voice                         | 1            | [Ios](/platforms/ios), [Talk](/nodes/talk)                                    | `Unscored` | `Experimental (43%)` | `Experimental (38%)` | No                |

#### watchOS companion surfaces

- Level: M1 Experimental
- Rationale: Source has Watch app/extension surfaces; public docs do not yet present this as a user feature.

| Area                      | Capabilities | Docs                                                           | Coverage   | Quality              | Completeness         | Long-term support |
| ------------------------- | ------------ | -------------------------------------------------------------- | ---------- | -------------------- | -------------------- | ----------------- |
| Delivery and Recovery     | 7            | [Ios](/platforms/ios)                                          | `Unscored` | `Alpha (60%)`        | `Experimental (46%)` | No                |
| Exec Approvals            | 3            | [Exec Approvals](/tools/exec-approvals), [Ios](/platforms/ios) | `Unscored` | `Alpha (64%)`        | `Alpha (54%)`        | No                |
| Distribution and Support  | 6            | [Ios](/platforms/ios)                                          | `Unscored` | `Experimental (48%)` | `Experimental (38%)` | No                |
| Notifications and Replies | 7            | [Ios](/platforms/ios)                                          | `Unscored` | `Alpha (57%)`        | `Experimental (44%)` | No                |
| Watch App UI              | 3            | [Ios](/platforms/ios)                                          | `Unscored` | `Alpha (58%)`        | `Experimental (42%)` | No                |

#### Raspberry Pi and small Linux devices

- Level: M3 Beta
- Rationale: Platform docs exist and Gateway path is Linux-based. Needs hardware-specific release smoke proof to move higher.

| Area                        | Capabilities | Docs                                                                                                                                                                                                                            | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Setup and Compatibility     | 12           | [Raspberry Pi](/install/raspberry-pi), [Index](/install/index), [Faq First Run](/help/faq-first-run), [Faq](/help/faq), [Linux](/platforms/linux), [Installer](/install/installer)                                              | `Unscored` | `Alpha (58%)` | `Alpha (55%)` | No                |
| Remote Access and Auth      | 9            | [Raspberry Pi](/install/raspberry-pi), [Authentication](/gateway/authentication), [Secrets](/gateway/secrets), [Pairing](/gateway/pairing), [Devices](/cli/devices), [Remote](/gateway/remote), [Tailscale](/gateway/tailscale) | `Unscored` | `Alpha (68%)` | `Beta (74%)`  | No                |
| Gateway Runtime             | 10           | [Index](/gateway/index), [Gateway](/cli/gateway), [Raspberry Pi](/install/raspberry-pi), [Linux](/platforms/linux), [Vps](/vps)                                                                                                 | `Unscored` | `Beta (72%)`  | `Beta (78%)`  | No                |
| Performance and Diagnostics | 5            | [Raspberry Pi](/install/raspberry-pi), [Linux](/platforms/linux), [Health](/gateway/health), [Diagnostics](/gateway/diagnostics)                                                                                                | `Unscored` | `Alpha (69%)` | `Beta (75%)`  | No                |

#### Docker and Podman hosting

- Level: M3 Beta
- Rationale: Install docs exist and are common deployment paths. Promote after recurring release smoke captures upgrade and volume behavior.

| Area                         | Capabilities | Docs                                                                                                                                                                | Coverage   | Quality       | Completeness   | Long-term support |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Container Setup              | 6            | [Docker](/install/docker), [Podman](/install/podman)                                                                                                                | `Unscored` | `Beta (76%)`  | `Beta (74%)`   | No                |
| Container Operations         | 11           | [Podman](/install/podman), [Docker Vm Runtime](/install/docker-vm-runtime), [Docker](/install/docker), [Hetzner](/install/hetzner), [Hostinger](/install/hostinger) | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | No                |
| Image Release and Validation | 5            | [Docker](/install/docker), [Docker Vm Runtime](/install/docker-vm-runtime), [Full Release Validation](/reference/full-release-validation)                           | `Unscored` | `Beta (78%)`  | `Stable (84%)` | No                |
| Agent Sandbox and Tooling    | 3            | [Docker](/install/docker), [Docker Vm Runtime](/install/docker-vm-runtime)                                                                                          | `Unscored` | `Alpha (68%)` | `Beta (75%)`   | No                |

#### Kubernetes hosting

- Level: M2 Alpha
- Rationale: Kubernetes hosting is a distinct Kustomize-based cluster deployment path. Current scoring shows a real minimal deployment path with gaps around Kubernetes-specific CI, ingress/TLS/NetworkPolicy packaging, backup/restore, and production exposure hardening.

| Area                      | Capabilities | Docs                                                                                                                                                            | Coverage   | Quality      | Completeness   | Long-term support |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | -------------- | ----------------- |
| Deployment Setup          | 5            | [Kubernetes](/install/kubernetes), [Index](/install/index)                                                                                                      | `Unscored` | `Beta (76%)` | `Stable (84%)` | No                |
| Configuration and Secrets | 5            | [Kubernetes](/install/kubernetes), [Secrets](/gateway/secrets), [Environment](/help/environment)                                                                | `Unscored` | `Beta (74%)` | `Beta (76%)`   | No                |
| Access and Exposure       | 5            | [Kubernetes](/install/kubernetes), [Authentication](/gateway/authentication), [Remote](/gateway/remote), [Exposure Runbook](/gateway/security/exposure-runbook) | `Unscored` | `Beta (72%)` | `Alpha (58%)`  | No                |
| Cluster Lifecycle         | 5            | [Kubernetes](/install/kubernetes), [Index](/gateway/index)                                                                                                      | `Unscored` | `Beta (78%)` | `Beta (77%)`   | No                |

#### Nix install path

- Level: M1 Experimental
- Rationale: Optional install flow. Needs clearer support promise before alpha/beta promotion.

| Area                       | Capabilities | Docs                                                                                    | Coverage   | Quality              | Completeness         | Long-term support |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------- | ---------- | -------------------- | -------------------- | ----------------- |
| Install Handoff            | 4            | [Nix](/install/nix), [Index](/install/index), [Docs Directory](/start/docs-directory)   | `Unscored` | `Experimental (45%)` | `Experimental (25%)` | No                |
| Plugin Lifecycle           | 4            | [Manage Plugins](/plugins/manage-plugins), [Plugin](/tools/plugin), [Nix](/install/nix) | `Unscored` | `Experimental (35%)` | `Experimental (40%)` | No                |
| Activation and App UX      | 7            | [Nix](/install/nix)                                                                     | `Unscored` | `Alpha (50%)`        | `Experimental (42%)` | No                |
| Config and State           | 7            | [Nix](/install/nix), [Setup](/cli/setup), [Environment](/help/environment)              | `Unscored` | `Alpha (50%)`        | `Experimental (45%)` | No                |
| Service Runtime and Guards | 8            | [Nix](/install/nix), [Setup](/cli/setup), [Doctor](/cli/doctor), [Update](/cli/update)  | `Unscored` | `Experimental (45%)` | `Experimental (38%)` | No                |

### Channel

#### Discord

- Level: M4 Stable
- Rationale: Deep docs and broad feature coverage. Voice/delegation paths should stay separately scored as beta/alpha.

| Area                              | Capabilities | Docs                                                                                                                                                                                                                                 | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 10           | [Discord](/channels/discord), [Discord](/plugins/reference/discord), [Fly](/install/fly), [Slash Commands](/tools/slash-commands), [Health](/gateway/health), [Channels](/cli/channels), [Config Channels](/gateway/config-channels) | `Unscored` | `Beta (71%)`  | `Beta (74%)`  | Yes               |
| Access and Identity               | 6            | [Discord](/channels/discord), [Pairing](/channels/pairing), [Access Groups](/channels/access-groups), [Groups](/channels/groups)                                                                                                     | `Unscored` | `Beta (72%)`  | `Beta (74%)`  | Yes               |
| Conversation Routing and Delivery | 12           | [Discord](/channels/discord), [Channel Routing](/channels/channel-routing), [Groups](/channels/groups), [Access Groups](/channels/access-groups), [Acp Agents](/tools/acp-agents), [Subagents](/tools/subagents)                     | `Unscored` | `Beta (72%)`  | `Beta (74%)`  | Yes               |
| Media and Rich Content            | 1            | [Discord](/channels/discord)                                                                                                                                                                                                         | `Unscored` | `Beta (72%)`  | `Beta (74%)`  | Yes               |
| Native Controls and Approvals     | 5            | [Discord](/channels/discord), [Slash Commands](/tools/slash-commands)                                                                                                                                                                | `Unscored` | `Beta (72%)`  | `Alpha (58%)` | No                |
| Realtime Voice and Calls          | 5            | [Discord](/channels/discord), [Openai](/providers/openai), [Elevenlabs](/providers/elevenlabs), [Qa E2e Automation](/concepts/qa-e2e-automation), [Config Channels](/gateway/config-channels)                                        | `Unscored` | `Alpha (66%)` | `Beta (74%)`  | No                |

#### Telegram

- Level: M3 Beta
- Rationale: Core channel is mature enough for regular use, but high-variance UX and media edge cases need recurring scenario proof.

| Area                              | Capabilities | Docs                                                                                                                                                                     | Coverage   | Quality       | Completeness | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------- | ------------ | ----------------- |
| Channel Setup and Operations      | 10           | [Telegram](/channels/telegram), [Config Channels](/gateway/config-channels), [Channels](/cli/channels)                                                                   | `Unscored` | `Beta (70%)`  | `Beta (76%)` | Yes               |
| Access and Identity               | 10           | [Telegram](/channels/telegram), [Pairing](/channels/pairing), [Access Groups](/channels/access-groups), [Groups](/channels/groups), [Multi Agent](/concepts/multi-agent) | `Unscored` | `Alpha (68%)` | `Beta (76%)` | Yes               |
| Conversation Routing and Delivery | 1            | [Telegram](/channels/telegram), [Groups](/channels/groups), [Multi Agent](/concepts/multi-agent)                                                                         | `Unscored` | `Alpha (68%)` | `Beta (74%)` | Yes               |
| Media and Rich Content            | 1            | [Telegram](/channels/telegram), [Location](/channels/location)                                                                                                           | `Unscored` | `Beta (72%)`  | `Beta (74%)` | Yes               |
| Native Controls and Approvals     | 9            | [Telegram](/channels/telegram), [Exec Approvals](/tools/exec-approvals), [Reactions](/tools/reactions)                                                                   | `Unscored` | `Beta (72%)`  | `Beta (74%)` | Yes               |

#### WhatsApp

- Level: M3 Beta
- Rationale: Core path is important and documented; upstream Baileys/session volatility keeps it below Stable.

| Area                              | Capabilities | Docs                                                                                                                                                                                              | Coverage   | Quality        | Completeness | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ------------ | ----------------- |
| Channel Setup and Operations      | 5            | [Whatsapp](/channels/whatsapp), [Config Channels](/gateway/config-channels), [Whatsapp](/plugins/reference/whatsapp), [Qa E2e Automation](/concepts/qa-e2e-automation), [Doctor](/gateway/doctor) | `Unscored` | `Beta (72%)`   | `Beta (74%)` | No                |
| Access and Identity               | 7            | [Whatsapp](/channels/whatsapp), [Config Channels](/gateway/config-channels), [Qa E2e Automation](/concepts/qa-e2e-automation), [Pairing](/channels/pairing)                                       | `Unscored` | `Beta (72%)`   | `Beta (76%)` | No                |
| Conversation Routing and Delivery | 4            | [Whatsapp](/channels/whatsapp), [Group Messages](/channels/group-messages)                                                                                                                        | `Unscored` | `Beta (72%)`   | `Beta (76%)` | No                |
| Media and Rich Content            | 2            | [Whatsapp](/channels/whatsapp)                                                                                                                                                                    | `Unscored` | `Stable (80%)` | `Beta (76%)` | No                |
| Native Controls and Approvals     | 2            | [Whatsapp](/channels/whatsapp)                                                                                                                                                                    | `Unscored` | `Stable (84%)` | `Beta (78%)` | No                |

#### Slack

- Level: M3 Beta
- Rationale: First-class channel docs and routing surface. Needs workspace install/admin scenario scorecards.

| Area                              | Capabilities | Docs                                                                                                                                                                                     | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 10           | [Slack](/channels/slack), [Slack](/plugins/reference/slack), [Secrets](/gateway/secrets), [Qa E2e Automation](/concepts/qa-e2e-automation), [Troubleshooting](/channels/troubleshooting) | `Unscored` | `Alpha (68%)` | `Beta (74%)`  | Yes               |
| Access and Identity               | 1            | [Slack](/channels/slack), [Pairing](/channels/pairing)                                                                                                                                   | `Unscored` | `Beta (70%)`  | `Beta (74%)`  | Yes               |
| Conversation Routing and Delivery | 5            | [Slack](/channels/slack), [Bot Loop Protection](/channels/bot-loop-protection), [Pairing](/channels/pairing)                                                                             | `Unscored` | `Alpha (66%)` | `Alpha (64%)` | Yes               |
| Media and Rich Content            | 1            | [Slack](/channels/slack), [Qa E2e Automation](/concepts/qa-e2e-automation)                                                                                                               | `Unscored` | `Alpha (66%)` | `Alpha (64%)` | Yes               |
| Native Controls and Approvals     | 8            | [Slack](/channels/slack), [Slash Commands](/tools/slash-commands), [Exec Approvals](/tools/exec-approvals)                                                                               | `Unscored` | `Beta (70%)`  | `Beta (72%)`  | Yes               |

#### iMessage and BlueBubbles

- Level: M3 Beta
- Rationale: Supported iMessage runs through imsg on a signed-in macOS Messages host; legacy BlueBubbles configs require migration. Keep macOS permissions, SSH wrapper, SIP/private API, and migration caveats visible.

| Area                              | Capabilities | Docs                                                                                                                                                                                                       | Coverage   | Quality      | Completeness  | Long-term support |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ------------- | ----------------- |
| Channel Setup and Operations      | 11           | [Bluebubbles Imessage](/announcements/bluebubbles-imessage), [Imessage From Bluebubbles](/channels/imessage-from-bluebubbles), [Config Channels](/gateway/config-channels), [Imessage](/channels/imessage) | `Unscored` | `Beta (70%)` | `Alpha (62%)` | No                |
| Access and Identity               | 6            | [Imessage](/channels/imessage), [Imessage From Bluebubbles](/channels/imessage-from-bluebubbles), [Config Channels](/gateway/config-channels)                                                              | `Unscored` | `Beta (74%)` | `Beta (75%)`  | No                |
| Conversation Routing and Delivery | 4            | [Imessage](/channels/imessage)                                                                                                                                                                             | `Unscored` | `Beta (73%)` | `Beta (74%)`  | No                |
| Media and Rich Content            | 7            | [Imessage](/channels/imessage), [Imessage From Bluebubbles](/channels/imessage-from-bluebubbles), [Config Channels](/gateway/config-channels)                                                              | `Unscored` | `Beta (71%)` | `Beta (73%)`  | No                |
| Native Controls and Approvals     | 3            | [Imessage](/channels/imessage)                                                                                                                                                                             | `Unscored` | `Beta (71%)` | `Beta (73%)`  | No                |

#### Signal

- Level: M2 Alpha
- Rationale: Supported channel docs exist; needs stronger install and reconnect proof.

| Area                              | Capabilities | Docs                                                            | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | --------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 7            | [Signal](/channels/signal), [Signal](/plugins/reference/signal) | `Unscored` | `Alpha (58%)` | `Alpha (55%)` | No                |
| Access and Identity               | 6            | [Signal](/channels/signal)                                      | `Unscored` | `Alpha (66%)` | `Beta (70%)`  | No                |
| Conversation Routing and Delivery | 1            | [Signal](/channels/signal)                                      | `Unscored` | `Alpha (66%)` | `Beta (70%)`  | No                |
| Media and Rich Content            | 7            | [Signal](/channels/signal)                                      | `Unscored` | `Alpha (68%)` | `Beta (70%)`  | No                |
| Native Controls and Approvals     | 3            | [Signal](/channels/signal)                                      | `Unscored` | `Alpha (68%)` | `Alpha (65%)` | No                |

#### Google Chat

- Level: M2 Alpha
- Rationale: Documented channel, but enterprise/admin setup raises maturity risk.

| Area                              | Capabilities | Docs                                                                                                                                                                                                                                                                                                                                                                                        | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 16           | [Googlechat](/channels/googlechat), [Googlechat](/plugins/reference/googlechat), [Config Channels](/gateway/config-channels), [Wizard Cli Reference](/start/wizard-cli-reference), [Secrets](/gateway/secrets), [Secretref Credential Surface](/reference/secretref-credential-surface), [Health](/gateway/health), [Plugin Inventory](/plugins/plugin-inventory), [Index](/channels/index) | `Unscored` | `Alpha (62%)` | `Alpha (64%)` | No                |
| Access and Identity               | 11           | [Googlechat](/channels/googlechat), [Pairing](/channels/pairing), [Access Groups](/channels/access-groups), [Config Channels](/gateway/config-channels), [Bot Loop Protection](/channels/bot-loop-protection), [Channel Routing](/channels/channel-routing)                                                                                                                                 | `Unscored` | `Alpha (55%)` | `Alpha (58%)` | No                |
| Conversation Routing and Delivery | 1            | [Googlechat](/channels/googlechat), [Bot Loop Protection](/channels/bot-loop-protection), [Access Groups](/channels/access-groups), [Channel Routing](/channels/channel-routing)                                                                                                                                                                                                            | `Unscored` | `Alpha (50%)` | `Alpha (55%)` | No                |
| Media and Rich Content            | 1            | [Googlechat](/channels/googlechat), [Message](/cli/message), [Media Understanding](/nodes/media-understanding), [Secretref Credential Surface](/reference/secretref-credential-surface)                                                                                                                                                                                                     | `Unscored` | `Alpha (50%)` | `Alpha (55%)` | No                |
| Native Controls and Approvals     | 16           | [Googlechat](/channels/googlechat), [Message](/cli/message), [Media Understanding](/nodes/media-understanding), [Secretref Credential Surface](/reference/secretref-credential-surface), [Reactions](/tools/reactions), [Slash Commands](/tools/slash-commands), [Config Agents](/gateway/config-agents), [Message Lifecycle Refactor](/concepts/message-lifecycle-refactor)                | `Unscored` | `Alpha (50%)` | `Alpha (55%)` | No                |

#### Matrix

- Level: M2 Alpha
- Rationale: Supported via bundled plugin. Needs bridge, auth, and room lifecycle scorecards.

| Area                              | Capabilities | Docs                                                                                                         | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 5            | [Matrix](/channels/matrix), [Matrix Migration](/channels/matrix-migration)                                   | `Unscored` | `Beta (74%)`  | `Beta (74%)`  | No                |
| Access and Identity               | 7            | [Matrix](/channels/matrix), [Groups](/channels/groups), [Bot Loop Protection](/channels/bot-loop-protection) | `Unscored` | `Alpha (66%)` | `Beta (72%)`  | No                |
| Conversation Routing and Delivery | 1            | [Matrix](/channels/matrix)                                                                                   | `Unscored` | `Alpha (66%)` | `Beta (72%)`  | No                |
| Media and Rich Content            | 1            | [Matrix](/channels/matrix)                                                                                   | `Unscored` | `Alpha (68%)` | `Beta (74%)`  | No                |
| Native Controls and Approvals     | 6            | [Matrix](/channels/matrix)                                                                                   | `Unscored` | `Alpha (68%)` | `Alpha (64%)` | No                |
| Encryption and Verification       | 3            | [Matrix](/channels/matrix), [Matrix Migration](/channels/matrix-migration)                                   | `Unscored` | `Alpha (68%)` | `Beta (76%)`  | No                |

#### Microsoft Teams

- Level: M2 Alpha
- Rationale: Enterprise auth/admin flows need explicit scenario proof.

| Area                              | Capabilities | Docs                                                                                                                                        | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 9            | [Msteams](/channels/msteams), [Msteams](/plugins/reference/msteams), [Config Channels](/gateway/config-channels), [Health](/gateway/health) | `Unscored` | `Alpha (64%)` | `Alpha (58%)` | No                |
| Access and Identity               | 9            | [Msteams](/channels/msteams), [Pairing](/channels/pairing), [Access Groups](/channels/access-groups)                                        | `Unscored` | `Alpha (62%)` | `Alpha (60%)` | No                |
| Conversation Routing and Delivery | 5            | [Msteams](/channels/msteams), [Groups](/channels/groups), [Channel Routing](/channels/channel-routing)                                      | `Unscored` | `Alpha (66%)` | `Alpha (68%)` | No                |
| Media and Rich Content            | 5            | [Msteams](/channels/msteams)                                                                                                                | `Unscored` | `Alpha (58%)` | `Alpha (62%)` | No                |
| Native Controls and Approvals     | 5            | [Msteams](/channels/msteams), [Exec Approvals Advanced](/tools/exec-approvals-advanced)                                                     | `Unscored` | `Alpha (66%)` | `Alpha (64%)` | No                |

#### Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat

- Level: M2 Alpha
- Rationale: Supported surfaces exist, but maturity likely varies by upstream and maintainer coverage. Score individually later.

| Area                              | Capabilities | Docs | Coverage   | Quality       | Completeness  | Long-term support |
| --------------------------------- | ------------ | ---- | ---------- | ------------- | ------------- | ----------------- |
| Channel Setup and Operations      | 1            |      | `Unscored` | `Alpha (58%)` | `Alpha (62%)` | No                |
| Access and Identity               | 1            |      | `Unscored` | `Alpha (58%)` | `Alpha (62%)` | No                |
| Conversation Routing and Delivery | 1            |      | `Unscored` | `Alpha (58%)` | `Alpha (62%)` | No                |
| Media and Rich Content            | 1            |      | `Unscored` | `Alpha (58%)` | `Alpha (62%)` | No                |

#### Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels

- Level: M2 Alpha
- Rationale: Important regional coverage, but public support level should be calibrated per account type, upstream approval, and maintainer proof.

| Area                              | Capabilities | Docs                                                                                                                                                   | Coverage   | Quality              | Completeness         | Long-term support |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------- | -------------------- | ----------------- |
| Channel Setup and Operations      | 6            | [Index](/channels/index), [Pairing](/channels/pairing), [Feishu](/plugins/reference/feishu), [Architecture Internals](/plugins/architecture-internals) | `Unscored` | `Experimental (44%)` | `Experimental (42%)` | No                |
| Access and Identity               | 1            |                                                                                                                                                        | `Unscored` | `Experimental (44%)` | `Experimental (42%)` | No                |
| Conversation Routing and Delivery | 1            |                                                                                                                                                        | `Unscored` | `Experimental (44%)` | `Experimental (42%)` | No                |
| Media and Rich Content            | 1            |                                                                                                                                                        | `Unscored` | `Alpha (55%)`        | `Experimental (47%)` | No                |

#### Voice Call channel

- Level: M1 Experimental
- Rationale: Optional/plugin path with complex realtime behavior. Needs scenario scorecard before public beta.

| Area                              | Capabilities | Docs                                                                                          | Coverage   | Quality       | Completeness         | Long-term support |
| --------------------------------- | ------------ | --------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------------- | ----------------- |
| Channel Setup and Operations      | 2            | [Voicecall](/cli/voicecall), [Voice Call](/plugins/voice-call), [Protocol](/gateway/protocol) | `Unscored` | `Alpha (56%)` | `Experimental (42%)` | No                |
| Access and Identity               | 1            | [Voice Call](/plugins/voice-call), [Voicecall](/cli/voicecall)                                | `Unscored` | `Alpha (62%)` | `Alpha (60%)`        | No                |
| Conversation Routing and Delivery | 1            | [Voice Call](/plugins/voice-call)                                                             | `Unscored` | `Alpha (58%)` | `Alpha (52%)`        | No                |
| Media and Rich Content            | 2            | [Voice Call](/plugins/voice-call), [Plugin Inventory](/plugins/plugin-inventory)              | `Unscored` | `Alpha (57%)` | `Experimental (48%)` | No                |
| Realtime Voice and Calls          | 2            | [Voice Call](/plugins/voice-call)                                                             | `Unscored` | `Alpha (55%)` | `Experimental (44%)` | No                |

### Provider and tool

#### OpenAI and Codex provider path

- Level: M3 Beta
- Rationale: Deep docs, OAuth/subscription path, realtime voice, image, and compatibility behavior. Provider churn keeps this from Stable without release-scorecard proof.

| Area                             | Capabilities | Docs                                                                                                                                                                                                                                    | Coverage   | Quality       | Completeness   | Long-term support |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------- | ----------------- |
| Model and Auth                   | 6            | [Openai](/providers/openai), [Codex Harness](/plugins/codex-harness), [Models](/concepts/models), [Oauth](/concepts/oauth), [Codex Harness Reference](/plugins/codex-harness-reference), [Auth Monitoring](/automation/auth-monitoring) | `Unscored` | `Alpha (66%)` | `Beta (78%)`   | Yes               |
| Responses and Tool Compatibility | 4            | [Openai](/providers/openai), [Openresponses Http Api](/gateway/openresponses-http-api), [Openai Http Api](/gateway/openai-http-api), [Codex Native Plugins](/plugins/codex-native-plugins)                                              | `Unscored` | `Beta (70%)`  | `Beta (76%)`   | Yes               |
| Native Codex Harness             | 2            | [Codex Harness](/plugins/codex-harness), [Codex Harness Runtime](/plugins/codex-harness-runtime), [Codex Harness Reference](/plugins/codex-harness-reference), [Codex Native Plugins](/plugins/codex-native-plugins)                    | `Unscored` | `Beta (72%)`  | `Stable (82%)` | Yes               |
| Image and Multimodal Input       | 2            | [Openai](/providers/openai), [Image Generation](/tools/image-generation), [Images](/nodes/images)                                                                                                                                       | `Unscored` | `Beta (72%)`  | `Stable (80%)` | No                |
| Voice and Realtime Audio         | 2            | [Openai](/providers/openai), [Discord](/channels/discord), [Voice Call](/plugins/voice-call)                                                                                                                                            | `Unscored` | `Alpha (68%)` | `Beta (72%)`   | No                |

#### Anthropic provider path

- Level: M3 Beta
- Rationale: First-class model provider. Needs recurring auth/catalog/tool-call scenario proof.

| Area                                 | Capabilities | Docs                                                                                                                                                                                                              | Coverage   | Quality        | Completeness   | Long-term support |
| ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Provider Auth and Recovery           | 9            | [Anthropic](/providers/anthropic), [Doctor](/gateway/doctor), [Configuration Examples](/gateway/configuration-examples), [Troubleshooting](/gateway/troubleshooting), [Prompt Caching](/reference/prompt-caching) | `Unscored` | `Beta (70%)`   | `Beta (78%)`   | No                |
| Model and Runtime Selection          | 10           | [Anthropic](/providers/anthropic), [Config Agents](/gateway/config-agents), [Models](/concepts/models), [Cli Backends](/gateway/cli-backends)                                                                     | `Unscored` | `Alpha (68%)`  | `Stable (82%)` | No                |
| Request Transport and Turn Semantics | 10           | [Anthropic](/providers/anthropic), [Prompt Caching](/reference/prompt-caching), [Troubleshooting](/gateway/troubleshooting), [Cli Backends](/gateway/cli-backends), [Model Providers](/concepts/model-providers)  | `Unscored` | `Beta (72%)`   | `Stable (82%)` | No                |
| Prompt Cache and Context             | 5            | [Anthropic](/providers/anthropic), [Prompt Caching](/reference/prompt-caching), [Troubleshooting](/gateway/troubleshooting), [Heartbeat](/gateway/heartbeat)                                                      | `Unscored` | `Beta (76%)`   | `Stable (82%)` | No                |
| Media Inputs                         | 4            | [Anthropic](/providers/anthropic), [Config Agents](/gateway/config-agents)                                                                                                                                        | `Unscored` | `Stable (82%)` | `Beta (74%)`   | No                |

#### Google provider path

- Level: M3 Beta
- Rationale: First-class provider with model and realtime surfaces. Needs separate Live/Talk scoring.

| Area                           | Capabilities | Docs                                                                                                                                                      | Coverage   | Quality        | Completeness   | Long-term support |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Provider Setup and Credentials | 10           | [Google](/providers/google), [Model Providers](/concepts/model-providers)                                                                                 | `Unscored` | `Alpha (60%)`  | `Beta (72%)`   | No                |
| Model Routing and Endpoints    | 10           | [Google](/providers/google), [Model Providers](/concepts/model-providers), [Google](/plugins/reference/google), [Gemini Search](/tools/gemini-search)     | `Unscored` | `Alpha (62%)`  | `Alpha (68%)`  | No                |
| Direct Gemini Runtime          | 9            | [Google](/providers/google), [Model Providers](/concepts/model-providers), [Faq Models](/help/faq-models), [Testing Live](/help/testing-live)             | `Unscored` | `Stable (80%)` | `Stable (82%)` | No                |
| Media, Search, and Realtime    | 10           | [Google](/plugins/reference/google), [Google](/providers/google)                                                                                          | `Unscored` | `Alpha (65%)`  | `Beta (76%)`   | No                |
| Prompt Caching                 | 5            | [Prompt Caching](/reference/prompt-caching), [Google](/providers/google), [Model Providers](/concepts/model-providers), [Token Use](/reference/token-use) | `Unscored` | `Beta (74%)`   | `Alpha (68%)`  | No                |

#### OpenRouter provider path

- Level: M3 Beta
- Rationale: Unified provider path is documented and valuable, but model-specific behavior varies.

| Area                              | Capabilities | Docs                                                                                                                                                                                                                                           | Coverage   | Quality       | Completeness | Long-term support |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------ | ----------------- |
| Provider Setup and Auth           | 14           | [Openrouter](/providers/openrouter), [Model Providers](/concepts/model-providers), [Configure](/cli/configure), [Authentication](/gateway/authentication), [Environment](/help/environment), [Models](/cli/models), [Models](/concepts/models) | `Unscored` | `Alpha (64%)` | `Beta (78%)` | No                |
| Chat Runtime and Normalization    | 15           | [Openrouter](/providers/openrouter), [Model Providers](/concepts/model-providers), [Prompt Caching](/reference/prompt-caching)                                                                                                                 | `Unscored` | `Beta (70%)`  | `Beta (76%)` | No                |
| Provider Recovery and Diagnostics | 5            | [Model Failover](/concepts/model-failover), [Openrouter](/providers/openrouter), [Models](/cli/models)                                                                                                                                         | `Unscored` | `Alpha (65%)` | `Beta (74%)` | No                |
| Media Generation and Speech       | 7            | [Openrouter](/providers/openrouter), [Image Generation](/tools/image-generation), [Music Generation](/tools/music-generation), [Media Overview](/tools/media-overview), [Video Generation](/tools/video-generation), [Tts](/tools/tts)         | `Unscored` | `Alpha (66%)` | `Beta (72%)` | No                |

#### Local model providers: Ollama, vLLM, SGLang, LM Studio

- Level: M2 Alpha
- Rationale: Useful and documented, but environment variance is high.

| Area                                       | Capabilities | Docs                                                                                                                                                                                                                                                                                                 | Coverage   | Quality        | Completeness   | Long-term support |
| ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ----------------- |
| Provider Setup, Lifecycle, and Diagnostics | 12           | [Local Models](/gateway/local-models), [Lmstudio](/providers/lmstudio), [Ollama](/providers/ollama), [Vllm](/providers/vllm), [Local Model Services](/gateway/local-model-services), [Config Agents](/gateway/config-agents), [Troubleshooting](/gateway/troubleshooting), [Doctor](/gateway/doctor) | `Unscored` | `Beta (72%)`   | `Beta (74%)`   | No                |
| Native Provider Plugins                    | 10           | [Ollama](/providers/ollama), [Lmstudio](/providers/lmstudio)                                                                                                                                                                                                                                         | `Unscored` | `Beta (78%)`   | `Beta (78%)`   | No                |
| OpenAI-Compatible Runtime Compatibility    | 8            | [Vllm](/providers/vllm), [Sglang](/providers/sglang), [Local Models](/gateway/local-models), [Lmstudio](/providers/lmstudio)                                                                                                                                                                         | `Unscored` | `Alpha (68%)`  | `Beta (74%)`   | No                |
| Local Memory and Embeddings                | 5            | [Memory](/concepts/memory), [Doctor](/gateway/doctor)                                                                                                                                                                                                                                                | `Unscored` | `Alpha (68%)`  | `Beta (76%)`   | No                |
| Network Safety and Prompt Controls         | 2            | [Index](/gateway/security/index), [Config Tools](/gateway/config-tools), [Local Models](/gateway/local-models)                                                                                                                                                                                       | `Unscored` | `Stable (82%)` | `Stable (82%)` | No                |

#### Long-tail hosted providers

- Level: M2 Alpha
- Rationale: Many docs/reference pages exist; score should be generated from provider metadata plus live smoke coverage.

| Area                   | Capabilities | Docs                                                                                                                                                              | Coverage   | Quality       | Completeness  | Long-term support |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ------------- | ----------------- |
| Hosted LLM Providers   | 12           | [Index](/providers/index), [Model Providers](/concepts/model-providers), [Testing Live](/help/testing-live), [Onboard](/cli/onboard)                              | `Unscored` | `Alpha (56%)` | `Alpha (58%)` | No                |
| Hosted Media Providers | 8            | [Manifest](/plugins/manifest), [Testing Live](/help/testing-live), [Index](/providers/index)                                                                      | `Unscored` | `Alpha (64%)` | `Beta (70%)`  | No                |
| Provider Operations    | 12           | [Index](/providers/index), [Model Providers](/concepts/model-providers), [Manifest](/plugins/manifest), [Testing Live](/help/testing-live), [Models](/cli/models) | `Unscored` | `Alpha (60%)` | `Alpha (64%)` | No                |

#### Web search tools

- Level: M3 Beta
- Rationale: Multiple providers and docs exist. Needs quota/error/SSRF proof per provider family.

| Area                        | Capabilities | Docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Coverage   | Quality        | Completeness   | Long-term support |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------- | -------------- | ----------------- |
| Search Providers            | 19           | [Web](/tools/web), [Brave Search](/tools/brave-search), [Tavily](/tools/tavily), [Exa Search](/tools/exa-search), [Firecrawl](/tools/firecrawl), [Perplexity Search](/tools/perplexity-search), [Duckduckgo Search](/tools/duckduckgo-search), [Searxng Search](/tools/searxng-search), [Gemini Search](/tools/gemini-search), [Grok Search](/tools/grok-search), [Kimi Search](/tools/kimi-search), [Minimax Search](/tools/minimax-search), [Ollama Search](/tools/ollama-search), [Sdk Subpaths](/plugins/sdk-subpaths), [Sdk Overview](/plugins/sdk-overview), [Manifest](/plugins/manifest) | `Unscored` | `Beta (72%)`   | `Beta (76%)`   | No                |
| Setup and Diagnostics       | 9            | [Web](/tools/web), [Web Fetch](/tools/web-fetch), [Faq](/help/faq), [Api Usage Costs](/reference/api-usage-costs), [Brave Search](/tools/brave-search), [Perplexity Search](/tools/perplexity-search), [Tavily](/tools/tavily), [Firecrawl](/tools/firecrawl)                                                                                                                                                                                                                                                                                                                                    | `Unscored` | `Beta (70%)`   | `Beta (74%)`   | No                |
| Network Safety              | 4            | [Web](/tools/web), [Web Fetch](/tools/web-fetch), [Firecrawl](/tools/firecrawl), [Searxng Search](/tools/searxng-search)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Unscored` | `Stable (84%)` | `Stable (84%)` | No                |
| Tool Availability and Fetch | 11           | [Config Tools](/gateway/config-tools), [Web Fetch](/tools/web-fetch), [Web](/tools/web), [Faq](/help/faq)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `Unscored` | `Stable (80%)` | `Stable (82%)` | No                |

#### Browser automation, exec, and sandbox tools

- Level: M3 Beta
- Rationale: Core tools are documented, but host security and permission UX should stay under active scorecard review.

| Area                          | Capabilities | Docs                                                                                                                                                                                                                                                                                                                                         | Coverage   | Quality      | Completeness   | Long-term support |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | -------------- | ----------------- |
| Browser Automation            | 8            | [Browser Control](/tools/browser-control), [Testing](/help/testing), [Browser](/tools/browser), [Index](/gateway/security/index), [Audit Checks](/gateway/security/audit-checks)                                                                                                                                                             | `Unscored` | `Beta (74%)` | `Beta (78%)`   | No                |
| Tool Invocation and Execution | 6            | [Exec](/tools/exec), [Background Process](/gateway/background-process), [Tools Invoke Http Api](/gateway/tools-invoke-http-api), [Operator Scopes](/gateway/operator-scopes), [Protocol](/gateway/protocol), [Exec Approvals](/tools/exec-approvals), [Exec Approvals Advanced](/tools/exec-approvals-advanced), [Elevated](/tools/elevated) | `Unscored` | `Beta (79%)` | `Stable (82%)` | Yes               |
| Sandbox and Tool Policy       | 6            | [Sandboxing](/gateway/sandboxing), [Sandbox Vs Tool Policy Vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated), [Multi Agent Sandbox Tools](/tools/multi-agent-sandbox-tools), [Codex Harness Reference](/plugins/codex-harness-reference), [Config Tools](/gateway/config-tools)                                                      | `Unscored` | `Beta (72%)` | `Beta (76%)`   | Yes               |

#### Image, video, and music generation tools

- Level: M2 Alpha
- Rationale: Capability exists across providers, but quality, latency, and parameter compatibility vary too much for beta without per-provider proof.

| Area                        | Capabilities | Docs                                                                                                                                                                           | Coverage   | Quality       | Completeness   | Long-term support |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------- | -------------- | ----------------- |
| Media Routing and Discovery | 4            | [Config Agents](/gateway/config-agents), [Image Generation](/tools/image-generation), [Video Generation](/tools/video-generation), [Music Generation](/tools/music-generation) | `Unscored` | `Beta (74%)`  | `Stable (82%)` | No                |
| Task Lifecycle and Delivery | 12           | [Media Overview](/tools/media-overview), [Image Generation](/tools/image-generation), [Video Generation](/tools/video-generation), [Music Generation](/tools/music-generation) | `Unscored` | `Alpha (65%)` | `Beta (78%)`   | No                |
| Image Generation            | 9            | [Image Generation](/tools/image-generation), [Infer](/cli/infer), [Media Overview](/tools/media-overview)                                                                      | `Unscored` | `Alpha (66%)` | `Beta (78%)`   | No                |
| Video Generation            | 11           | [Video Generation](/tools/video-generation), [Runway](/providers/runway), [Pixverse](/providers/pixverse), [Fal](/providers/fal), [Openrouter](/providers/openrouter)          | `Unscored` | `Alpha (62%)` | `Beta (76%)`   | No                |
| Music Generation            | 6            | [Music Generation](/tools/music-generation)                                                                                                                                    | `Unscored` | `Alpha (61%)` | `Beta (72%)`   | No                |
