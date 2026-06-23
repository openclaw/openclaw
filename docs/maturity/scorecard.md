---
title: "Maturity scorecard"
summary: "OpenClaw release readiness scores for product areas, integrations, and supported workflows."
---

# Maturity scorecard

These scores summarize release readiness across OpenClaw product areas, integrations, and supported workflows.

The current scorecard covers 50 surfaces and 281 capability areas.

## Overall scores

| Basis            | Coverage   | Quality       | Completeness |
| ---------------- | ---------- | ------------- | ------------ |
| Surface average  | `Unscored` | `Alpha (63%)` | `Beta (70%)` |
| Category average | `Unscored` | `Alpha (64%)` | `Beta (71%)` |

- Coverage is derived from release validation results.
- Quality measures reliability and operational confidence.
- Completeness measures how much of the expected user workflow is available.

## Score bands

| Label        | Score range |
| ------------ | ----------- |
| Lovable      | 95-100%     |
| Stable       | 80-95%      |
| Beta         | 70-80%      |
| Alpha        | 50-70%      |
| Experimental | 0-50%       |

## Surface scorecard

| Surface                                                                                                                                                            | Family            | Level           | Coverage             | Quality              | Completeness         | Long-term support | Areas |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------- | -------------------- | -------------------- | -------------------- | ----------------- | ----- |
| [Gateway runtime](/maturity/taxonomy#gateway-runtime)                                                                                                              | Core              | M4 Stable       | `Experimental (3%)`  | `Stable (81%)`       | `Stable (89%)`       | partial (12)      | 13    |
| [CLI](/maturity/taxonomy#cli)                                                                                                                                      | Core              | M4 Stable       | `Experimental (2%)`  | `Stable (83%)`       | `Stable (90%)`       | partial (6)       | 7     |
| [Plugins](/maturity/taxonomy#plugins)                                                                                                                              | Core              | M3 Beta         | `Experimental (2%)`  | `Beta (72%)`         | `Beta (79%)`         | partial (7)       | 9     |
| [Agent Runtime](/maturity/taxonomy#agent-runtime)                                                                                                                  | Core              | M3 Beta         | `Experimental (2%)`  | `Beta (78%)`         | `Beta (79%)`         | partial (6)       | 9     |
| [Session, memory, and context engine](/maturity/taxonomy#session-memory-and-context-engine)                                                                        | Core              | M3 Beta         | `Experimental (0%)`  | `Beta (77%)`         | `Beta (79%)`         | partial (6)       | 9     |
| [Channel framework](/maturity/taxonomy#channel-framework)                                                                                                          | Core              | M3 Beta         | `Experimental (0%)`  | `Beta (76%)`         | `Beta (79%)`         | partial (5)       | 8     |
| [Security, auth, pairing, and secrets](/maturity/taxonomy#security-auth-pairing-and-secrets)                                                                       | Core              | M3 Beta         | `Experimental (0%)`  | `Beta (72%)`         | `Beta (79%)`         | partial (5)       | 6     |
| [Observability](/maturity/taxonomy#observability)                                                                                                                  | Core              | M3 Beta         | `Experimental (6%)`  | `Beta (75%)`         | `Beta (79%)`         | partial (3)       | 5     |
| [Automation: cron, hooks, tasks, polling](/maturity/taxonomy#automation-cron-hooks-tasks-polling)                                                                  | Core              | M3 Beta         | `Experimental (0%)`  | `Beta (72%)`         | `Beta (79%)`         | none              | 6     |
| [Media understanding and media generation](/maturity/taxonomy#media-understanding-and-media-generation)                                                            | Core              | M2 Alpha        | `Unscored`           | `Alpha (64%)`        | `Alpha (68%)`        | none              | 6     |
| [Voice and realtime talk](/maturity/taxonomy#voice-and-realtime-talk)                                                                                              | Core              | M2 Alpha        | `Unscored`           | `Alpha (61%)`        | `Alpha (68%)`        | none              | 6     |
| [Gateway Web App](/maturity/taxonomy#gateway-web-app)                                                                                                              | Core              | M3 Beta         | `Experimental (0%)`  | `Beta (74%)`         | `Beta (79%)`         | none              | 6     |
| [TUI](/maturity/taxonomy#tui)                                                                                                                                      | Core              | M2 Alpha        | `Unscored`           | `Alpha (59%)`        | `Alpha (66%)`        | none              | 5     |
| [ClawHub](/maturity/taxonomy#clawhub)                                                                                                                              | Core              | M2 Alpha        | `Unscored`           | `Alpha (58%)`        | `Alpha (62%)`        | none              | 4     |
| [OpenClaw App SDK](/maturity/taxonomy#openclaw-app-sdk)                                                                                                            | Core              | M2 Alpha        | `Unscored`           | `Alpha (54%)`        | `Alpha (53%)`        | none              | 6     |
| [macOS Gateway host](/maturity/taxonomy#macos-gateway-host)                                                                                                        | Platform          | M4 Stable       | `Experimental (0%)`  | `Beta (74%)`         | `Stable (88%)`       | none              | 7     |
| [macOS companion app](/maturity/taxonomy#macos-companion-app)                                                                                                      | Platform          | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | none              | 8     |
| [Linux Gateway host](/maturity/taxonomy#linux-gateway-host)                                                                                                        | Platform          | M4 Stable       | `Experimental (0%)`  | `Beta (75%)`         | `Stable (89%)`       | partial (4)       | 5     |
| [Linux companion app](/maturity/taxonomy#linux-companion-app)                                                                                                      | Platform          | M0 Planned      | `Unscored`           | `Experimental (19%)` | `Experimental (21%)` | none              | 5     |
| [Windows via WSL2](/maturity/taxonomy#windows-via-wsl2)                                                                                                            | Platform          | M3 Beta         | `Experimental (3%)`  | `Alpha (69%)`        | `Beta (79%)`         | partial (5)       | 6     |
| [Native Windows](/maturity/taxonomy#native-windows)                                                                                                                | Platform          | M2 Alpha        | `Unscored`           | `Alpha (58%)`        | `Alpha (66%)`        | partial (1)       | 4     |
| [Native Windows companion app](/maturity/taxonomy#native-windows-companion-app)                                                                                    | Platform          | M0 Planned      | `Unscored`           | `Experimental (19%)` | `Experimental (21%)` | none              | 5     |
| [Android app](/maturity/taxonomy#android-app)                                                                                                                      | Platform          | M2 Alpha        | `Unscored`           | `Alpha (59%)`        | `Alpha (66%)`        | none              | 7     |
| [iOS app](/maturity/taxonomy#ios-app)                                                                                                                              | Platform          | M1 Experimental | `Unscored`           | `Experimental (41%)` | `Experimental (44%)` | none              | 8     |
| [watchOS companion surfaces](/maturity/taxonomy#watchos-companion-surfaces)                                                                                        | Platform          | M1 Experimental | `Unscored`           | `Experimental (41%)` | `Experimental (44%)` | none              | 5     |
| [Raspberry Pi and small Linux devices](/maturity/taxonomy#raspberry-pi-and-small-linux-devices)                                                                    | Platform          | M3 Beta         | `Experimental (0%)`  | `Alpha (67%)`        | `Beta (79%)`         | none              | 4     |
| [Docker and Podman hosting](/maturity/taxonomy#docker-and-podman-hosting)                                                                                          | Platform          | M3 Beta         | `Experimental (5%)`  | `Beta (71%)`         | `Beta (79%)`         | none              | 4     |
| [Kubernetes hosting](/maturity/taxonomy#kubernetes-hosting)                                                                                                        | Platform          | M2 Alpha        | `Unscored`           | `Alpha (55%)`        | `Alpha (61%)`        | none              | 4     |
| [Nix install path](/maturity/taxonomy#nix-install-path)                                                                                                            | Platform          | M1 Experimental | `Unscored`           | `Experimental (41%)` | `Experimental (44%)` | none              | 5     |
| [Discord](/maturity/taxonomy#discord)                                                                                                                              | Channel           | M4 Stable       | `Experimental (0%)`  | `Beta (73%)`         | `Stable (87%)`       | partial (4)       | 6     |
| [Telegram](/maturity/taxonomy#telegram)                                                                                                                            | Channel           | M3 Beta         | `Experimental (0%)`  | `Alpha (68%)`        | `Beta (78%)`         | full (5)          | 5     |
| [WhatsApp](/maturity/taxonomy#whatsapp)                                                                                                                            | Channel           | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | none              | 5     |
| [Slack](/maturity/taxonomy#slack)                                                                                                                                  | Channel           | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | full (5)          | 5     |
| [iMessage and BlueBubbles](/maturity/taxonomy#imessage-and-bluebubbles)                                                                                            | Channel           | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | none              | 5     |
| [Signal](/maturity/taxonomy#signal)                                                                                                                                | Channel           | M2 Alpha        | `Unscored`           | `Alpha (59%)`        | `Alpha (66%)`        | none              | 5     |
| [Google Chat](/maturity/taxonomy#google-chat)                                                                                                                      | Channel           | M2 Alpha        | `Unscored`           | `Alpha (59%)`        | `Alpha (66%)`        | none              | 5     |
| [Matrix](/maturity/taxonomy#matrix)                                                                                                                                | Channel           | M2 Alpha        | `Unscored`           | `Alpha (60%)`        | `Alpha (67%)`        | none              | 6     |
| [Microsoft Teams](/maturity/taxonomy#microsoft-teams)                                                                                                              | Channel           | M2 Alpha        | `Unscored`           | `Alpha (59%)`        | `Alpha (66%)`        | none              | 5     |
| [Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat](/maturity/taxonomy#mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat) | Channel           | M2 Alpha        | `Unscored`           | `Alpha (53%)`        | `Alpha (54%)`        | none              | 4     |
| [Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels](/maturity/taxonomy#feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels)    | Channel           | M2 Alpha        | `Unscored`           | `Alpha (55%)`        | `Alpha (58%)`        | none              | 4     |
| [Voice Call channel](/maturity/taxonomy#voice-call-channel)                                                                                                        | Channel           | M1 Experimental | `Unscored`           | `Experimental (41%)` | `Experimental (44%)` | none              | 5     |
| [OpenAI and Codex provider path](/maturity/taxonomy#openai-and-codex-provider-path)                                                                                | Provider and tool | M3 Beta         | `Experimental (8%)`  | `Beta (74%)`         | `Beta (79%)`         | partial (3)       | 5     |
| [Anthropic provider path](/maturity/taxonomy#anthropic-provider-path)                                                                                              | Provider and tool | M3 Beta         | `Experimental (0%)`  | `Beta (71%)`         | `Beta (78%)`         | none              | 5     |
| [Google provider path](/maturity/taxonomy#google-provider-path)                                                                                                    | Provider and tool | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | none              | 5     |
| [OpenRouter provider path](/maturity/taxonomy#openrouter-provider-path)                                                                                            | Provider and tool | M3 Beta         | `Experimental (0%)`  | `Alpha (66%)`        | `Beta (78%)`         | none              | 4     |
| [Local model providers: Ollama, vLLM, SGLang, LM Studio](/maturity/taxonomy#local-model-providers-ollama-vllm-sglang-lm-studio)                                    | Provider and tool | M2 Alpha        | `Unscored`           | `Alpha (61%)`        | `Alpha (68%)`        | none              | 5     |
| [Long-tail hosted providers](/maturity/taxonomy#long-tail-hosted-providers)                                                                                        | Provider and tool | M2 Alpha        | `Unscored`           | `Alpha (61%)`        | `Alpha (68%)`        | none              | 3     |
| [Web search tools](/maturity/taxonomy#web-search-tools)                                                                                                            | Provider and tool | M3 Beta         | `Experimental (7%)`  | `Beta (74%)`         | `Beta (79%)`         | none              | 4     |
| [Browser automation, exec, and sandbox tools](/maturity/taxonomy#browser-automation-exec-and-sandbox-tools)                                                        | Provider and tool | M3 Beta         | `Experimental (15%)` | `Beta (75%)`         | `Beta (79%)`         | partial (2)       | 3     |
| [Image, video, and music generation tools](/maturity/taxonomy#image-video-and-music-generation-tools)                                                              | Provider and tool | M2 Alpha        | `Unscored`           | `Alpha (61%)`        | `Alpha (68%)`        | none              | 5     |

## Release check summary

The checks below show which scorecard areas were exercised during release validation.

| Check set          | Completed                | Checks run | Results                                   | Areas reviewed | Capabilities reviewed |
| ------------------ | ------------------------ | ---------- | ----------------------------------------- | -------------- | --------------------- |
| Release validation | 2026-06-23T02:27:03.066Z | 96         | 87 passed, 7 failed, 2 blocked, 0 skipped | 0 of 167 (0%)  | 20 of 1083 (1.8%)     |

### Readiness by area

| Check set          | Surface                                     | Area                                    | Status             | Capabilities reviewed | Follow-up          |
| ------------------ | ------------------------------------------- | --------------------------------------- | ------------------ | --------------------- | ------------------ |
| Release validation | Agent Runtime                               | Agent Turn Execution                    | Needs review       | 0 of 3 (0%)           | 15 capability gaps |
| Release validation | Agent Runtime                               | External Runtimes and Subagents         | Needs review       | 0 of 4 (0%)           | 7 capability gaps  |
| Release validation | Agent Runtime                               | Hosted Provider Execution               | Partially reviewed | 1 of 5 (20%)          | 4 capability gaps  |
| Release validation | Agent Runtime                               | Local and Self-hosted Providers         | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Agent Runtime                               | Model and Runtime Selection             | Needs review       | 0 of 4 (0%)           | 6 capability gaps  |
| Release validation | Agent Runtime                               | Provider Auth                           | Needs review       | 0 of 10 (0%)          | 13 capability gaps |
| Release validation | Agent Runtime                               | Streaming and Progress                  | Needs review       | 0 of 2 (0%)           | 4 capability gaps  |
| Release validation | Agent Runtime                               | Tool Calls and Response Handling        | Needs review       | 0 of 3 (0%)           | 8 capability gaps  |
| Release validation | Agent Runtime                               | Tool Execution Controls                 | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Anthropic provider path                     | Media Inputs                            | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Anthropic provider path                     | Model and Runtime Selection             | Needs review       | 0 of 10 (0%)          | 12 capability gaps |
| Release validation | Anthropic provider path                     | Prompt Cache and Context                | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Anthropic provider path                     | Provider Auth and Recovery              | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Anthropic provider path                     | Request Transport and Turn Semantics    | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Automation: cron, hooks, tasks, polling     | Automation Hooks                        | Needs review       | 0 of 11 (0%)          | 11 capability gaps |
| Release validation | Automation: cron, hooks, tasks, polling     | Background Tasks and Flows              | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Automation: cron, hooks, tasks, polling     | Cron Jobs                               | Needs review       | 0 of 15 (0%)          | 15 capability gaps |
| Release validation | Automation: cron, hooks, tasks, polling     | Event Ingress                           | Needs review       | 0 of 15 (0%)          | 15 capability gaps |
| Release validation | Automation: cron, hooks, tasks, polling     | Heartbeat                               | Needs review       | 0 of 5 (0%)           | 6 capability gaps  |
| Release validation | Automation: cron, hooks, tasks, polling     | Polling Controls                        | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Browser automation, exec, and sandbox tools | Browser Automation                      | Partially reviewed | 1 of 8 (12.5%)        | 7 capability gaps  |
| Release validation | Browser automation, exec, and sandbox tools | Sandbox and Tool Policy                 | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Browser automation, exec, and sandbox tools | Tool Invocation and Execution           | Partially reviewed | 2 of 6 (33.3%)        | 4 capability gaps  |
| Release validation | Gateway Web App                             | Browser Access and Trust                | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Gateway Web App                             | Browser Realtime Talk                   | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Gateway Web App                             | Browser UI                              | Needs review       | 0 of 10 (0%)          | 11 capability gaps |
| Release validation | Gateway Web App                             | Configuration                           | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Gateway Web App                             | Operator Console                        | Needs review       | 0 of 10 (0%)          | 11 capability gaps |
| Release validation | Gateway Web App                             | WebChat Conversations                   | Needs review       | 0 of 15 (0%)          | 18 capability gaps |
| Release validation | Channel framework                           | Channel Actions Commands and Approvals  | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Channel framework                           | Channel Setup                           | Needs review       | 0 of 5 (0%)           | 6 capability gaps  |
| Release validation | Channel framework                           | Conversation Routing and Delivery       | Needs review       | 0 of 10 (0%)          | 22 capability gaps |
| Release validation | Channel framework                           | Group Thread and Ambient Room Behavior  | Needs review       | 0 of 5 (0%)           | 7 capability gaps  |
| Release validation | Channel framework                           | Inbound Access and Identity Gates       | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Channel framework                           | Media Attachments and Rich Channel Data | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Channel framework                           | Outbound Delivery and Reply Pipeline    | Needs review       | 0 of 4 (0%)           | 13 capability gaps |
| Release validation | Channel framework                           | Status Health and Operator Controls     | Needs review       | 0 of 4 (0%)           | 6 capability gaps  |
| Release validation | CLI                                         | CLI Observability                       | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | CLI                                         | CLI Setup                               | Partially reviewed | 1 of 6 (16.7%)        | 5 capability gaps  |
| Release validation | CLI                                         | Doctor                                  | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | CLI                                         | Gateway Service Management              | Needs review       | 0 of 5 (0%)           | 6 capability gaps  |
| Release validation | CLI                                         | Onboarding and Auth Setup               | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | CLI                                         | Plugin and Channel Setup                | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | CLI                                         | Updates and Upgrades                    | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Discord                                     | Access and Identity                     | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Discord                                     | Channel Setup and Operations            | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Discord                                     | Conversation Routing and Delivery       | Needs review       | 0 of 12 (0%)          | 12 capability gaps |
| Release validation | Discord                                     | Media and Rich Content                  | Needs review       | 0 of 1 (0%)           | 1 capability gap   |
| Release validation | Discord                                     | Native Controls and Approvals           | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Discord                                     | Realtime Voice and Calls                | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Docker and Podman hosting                   | Agent Sandbox and Tooling               | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | Docker and Podman hosting                   | Container Operations                    | Needs review       | 0 of 11 (0%)          | 11 capability gaps |
| Release validation | Docker and Podman hosting                   | Container Setup                         | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Docker and Podman hosting                   | Image Release and Validation            | Partially reviewed | 1 of 5 (20%)          | 5 capability gaps  |
| Release validation | Gateway runtime                             | Approvals and Remote Execution          | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Gateway runtime                             | Device Auth and Pairing                 | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Gateway runtime                             | Gateway Lifecycle                       | Needs review       | 0 of 7 (0%)           | 8 capability gaps  |
| Release validation | Gateway runtime                             | Gateway RPC APIs and Events             | Needs review       | 0 of 20 (0%)          | 20 capability gaps |
| Release validation | Gateway runtime                             | Health, Diagnostics, and Repair         | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | Gateway runtime                             | Hosted Web Surface                      | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Gateway runtime                             | HTTP APIs                               | Partially reviewed | 1 of 4 (25%)          | 3 capability gaps  |
| Release validation | Gateway runtime                             | Network Access and Discovery            | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Gateway runtime                             | Nodes and Remote Capabilities           | Needs review       | 0 of 8 (0%)           | 8 capability gaps  |
| Release validation | Gateway runtime                             | Protocol Compatibility                  | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | Gateway runtime                             | Roles and Permissions                   | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Gateway runtime                             | Security Controls                       | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Gateway runtime                             | WebSocket Connection                    | Partially reviewed | 1 of 8 (12.5%)        | 7 capability gaps  |
| Release validation | Google provider path                        | Direct Gemini Runtime                   | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Google provider path                        | Media, Search, and Realtime             | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Google provider path                        | Model Routing and Endpoints             | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Google provider path                        | Prompt Caching                          | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Google provider path                        | Provider Setup and Credentials          | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | iMessage and BlueBubbles                    | Access and Identity                     | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | iMessage and BlueBubbles                    | Channel Setup and Operations            | Needs review       | 0 of 11 (0%)          | 11 capability gaps |
| Release validation | iMessage and BlueBubbles                    | Conversation Routing and Delivery       | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | iMessage and BlueBubbles                    | Media and Rich Content                  | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | iMessage and BlueBubbles                    | Native Controls and Approvals           | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | Linux Gateway host                          | Deployment Targets                      | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | Linux Gateway host                          | Diagnostics and Repair                  | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Linux Gateway host                          | Gateway Runtime and Service Control     | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Linux Gateway host                          | Host Setup and Updates                  | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Linux Gateway host                          | Remote Access and Security              | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | macOS companion app                         | Canvas                                  | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | macOS companion app                         | Local Setup                             | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | macOS companion app                         | Native Capabilities                     | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | macOS companion app                         | Remote Connections                      | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | macOS companion app                         | Remote WebChat                          | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | macOS companion app                         | Status and Settings                     | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | macOS companion app                         | Voice and Talk                          | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | macOS companion app                         | WebChat                                 | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | macOS Gateway host                          | CLI Setup                               | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | macOS Gateway host                          | Diagnostics and Observability           | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | macOS Gateway host                          | Gateway Service Lifecycle               | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | macOS Gateway host                          | Local Gateway Integration               | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | macOS Gateway host                          | Permissions and Native Capabilities     | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | macOS Gateway host                          | Profiles and Isolation                  | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | macOS Gateway host                          | Remote Gateway Mode                     | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Media understanding and media generation    | Media Generation                        | Partially reviewed | 1 of 17 (5.9%)        | 18 capability gaps |
| Release validation | Media understanding and media generation    | Media Understanding                     | Needs review       | 0 of 12 (0%)          | 13 capability gaps |
| Release validation | Native Windows                              | CLI                                     | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | OpenAI and Codex provider path              | Image and Multimodal Input              | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | OpenAI and Codex provider path              | Model and Auth                          | Partially reviewed | 1 of 6 (16.7%)        | 5 capability gaps  |
| Release validation | OpenAI and Codex provider path              | Native Codex Harness                    | Needs review       | 0 of 2 (0%)           | 5 capability gaps  |
| Release validation | OpenAI and Codex provider path              | Responses and Tool Compatibility        | Partially reviewed | 1 of 4 (25%)          | 3 capability gaps  |
| Release validation | OpenAI and Codex provider path              | Voice and Realtime Audio                | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | OpenRouter provider path                    | Chat Runtime and Normalization          | Needs review       | 0 of 15 (0%)          | 15 capability gaps |
| Release validation | OpenRouter provider path                    | Media Generation and Speech             | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | OpenRouter provider path                    | Provider Recovery and Diagnostics       | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | OpenRouter provider path                    | Provider Setup and Auth                 | Needs review       | 0 of 14 (0%)          | 14 capability gaps |
| Release validation | Plugins                                     | Authoring and Packaging plugins         | Needs review       | 0 of 8 (0%)           | 8 capability gaps  |
| Release validation | Plugins                                     | Bundled plugins                         | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Plugins                                     | Canvas plugin                           | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Plugins                                     | Channel plugins                         | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Plugins                                     | Installing and running plugins          | Needs review       | 0 of 6 (0%)           | 13 capability gaps |
| Release validation | Plugins                                     | Plugin approvals                        | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Plugins                                     | Provider and tool plugins               | Partially reviewed | 1 of 6 (16.7%)        | 12 capability gaps |
| Release validation | Plugins                                     | Publishing plugins                      | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Plugins                                     | Testing plugins                         | Needs review       | 0 of 6 (0%)           | 8 capability gaps  |
| Release validation | Raspberry Pi and small Linux devices        | Gateway Runtime                         | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Raspberry Pi and small Linux devices        | Performance and Diagnostics             | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Raspberry Pi and small Linux devices        | Remote Access and Auth                  | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Raspberry Pi and small Linux devices        | Setup and Compatibility                 | Needs review       | 0 of 12 (0%)          | 12 capability gaps |
| Release validation | Security, auth, pairing, and secrets        | Approval Policy and Tool Safeguards     | Needs review       | 0 of 2 (0%)           | 3 capability gaps  |
| Release validation | Security, auth, pairing, and secrets        | Channel Access Control                  | Needs review       | 0 of 3 (0%)           | 3 capability gaps  |
| Release validation | Security, auth, pairing, and secrets        | Credential and Secret Hygiene           | Needs review       | 0 of 5 (0%)           | 6 capability gaps  |
| Release validation | Security, auth, pairing, and secrets        | Device and Node Pairing                 | Needs review       | 0 of 11 (0%)          | 11 capability gaps |
| Release validation | Security, auth, pairing, and secrets        | Gateway Auth and Remote Access          | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Security, auth, pairing, and secrets        | Plugin Trust                            | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | Session, memory, and context engine         | CLI Session and Transcript Management   | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | Session, memory, and context engine         | Context Engine                          | Needs review       | 0 of 2 (0%)           | 3 capability gaps  |
| Release validation | Session, memory, and context engine         | Core Prompts and Context                | Needs review       | 0 of 2 (0%)           | 5 capability gaps  |
| Release validation | Session, memory, and context engine         | Cross-client History and Session Parity | Needs review       | 0 of 2 (0%)           | 3 capability gaps  |
| Release validation | Session, memory, and context engine         | Diagnostics, Maintenance, and Recovery  | Needs review       | 0 of 3 (0%)           | 6 capability gaps  |
| Release validation | Session, memory, and context engine         | Memory                                  | Needs review       | 0 of 5 (0%)           | 7 capability gaps  |
| Release validation | Session, memory, and context engine         | Session Routing                         | Needs review       | 0 of 2 (0%)           | 3 capability gaps  |
| Release validation | Session, memory, and context engine         | Token Management                        | Needs review       | 0 of 3 (0%)           | 6 capability gaps  |
| Release validation | Session, memory, and context engine         | Transcript Persistence                  | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | Slack                                       | Access and Identity                     | Needs review       | 0 of 1 (0%)           | 1 capability gap   |
| Release validation | Slack                                       | Channel Setup and Operations            | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Slack                                       | Conversation Routing and Delivery       | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Slack                                       | Media and Rich Content                  | Needs review       | 0 of 1 (0%)           | 1 capability gap   |
| Release validation | Slack                                       | Native Controls and Approvals           | Needs review       | 0 of 8 (0%)           | 8 capability gaps  |
| Release validation | Telegram                                    | Access and Identity                     | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Telegram                                    | Channel Setup and Operations            | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Telegram                                    | Conversation Routing and Delivery       | Needs review       | 0 of 1 (0%)           | 1 capability gap   |
| Release validation | Telegram                                    | Media and Rich Content                  | Needs review       | 0 of 1 (0%)           | 1 capability gap   |
| Release validation | Telegram                                    | Native Controls and Approvals           | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Observability                               | Diagnostic Collection                   | Partially reviewed | 1 of 8 (12.5%)        | 7 capability gaps  |
| Release validation | Observability                               | Health and Repair                       | Partially reviewed | 1 of 12 (8.3%)        | 13 capability gaps |
| Release validation | Observability                               | Logging                                 | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | Observability                               | Session Diagnostics                     | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Observability                               | Telemetry Export                        | Partially reviewed | 1 of 13 (7.7%)        | 14 capability gaps |
| Release validation | Web search tools                            | Network Safety                          | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | Web search tools                            | Search Providers                        | Partially reviewed | 2 of 19 (10.5%)       | 17 capability gaps |
| Release validation | Web search tools                            | Setup and Diagnostics                   | Needs review       | 0 of 9 (0%)           | 9 capability gaps  |
| Release validation | Web search tools                            | Tool Availability and Fetch             | Partially reviewed | 2 of 11 (18.2%)       | 9 capability gaps  |
| Release validation | WhatsApp                                    | Access and Identity                     | Needs review       | 0 of 7 (0%)           | 7 capability gaps  |
| Release validation | WhatsApp                                    | Channel Setup and Operations            | Needs review       | 0 of 5 (0%)           | 5 capability gaps  |
| Release validation | WhatsApp                                    | Conversation Routing and Delivery       | Needs review       | 0 of 4 (0%)           | 4 capability gaps  |
| Release validation | WhatsApp                                    | Media and Rich Content                  | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | WhatsApp                                    | Native Controls and Approvals           | Needs review       | 0 of 2 (0%)           | 2 capability gaps  |
| Release validation | Windows via WSL2                            | Browser and Control UI                  | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |
| Release validation | Windows via WSL2                            | CLI                                     | Needs review       | 0 of 8 (0%)           | 8 capability gaps  |
| Release validation | Windows via WSL2                            | Diagnostics and Repair                  | Partially reviewed | 1 of 6 (16.7%)        | 5 capability gaps  |
| Release validation | Windows via WSL2                            | Gateway Access and Exposure             | Needs review       | 0 of 11 (0%)          | 11 capability gaps |
| Release validation | Windows via WSL2                            | Gateway Service Lifecycle               | Needs review       | 0 of 10 (0%)          | 10 capability gaps |
| Release validation | Windows via WSL2                            | WSL Setup                               | Needs review       | 0 of 6 (0%)           | 6 capability gaps  |

> Last updated: 2026-06-22
