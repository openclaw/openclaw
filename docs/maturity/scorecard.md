---
title: "Maturity scorecard"
summary: "OpenClaw release readiness scores for product areas, integrations, and supported workflows."
---

# Maturity scorecard

These scores summarize release readiness across OpenClaw product areas, integrations, and supported workflows.

The current scorecard covers 50 surfaces and 281 capability areas.

## Overall scores

| Basis            | Coverage      | Quality       | Completeness  |
| ---------------- | ------------- | ------------- | ------------- |
| Surface average  | `Alpha (68%)` | `Alpha (66%)` | `Alpha (68%)` |
| Category average | `Alpha (69%)` | `Alpha (66%)` | `Alpha (69%)` |

- Coverage measures how much of the area has release proof.
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
| [Gateway runtime](/maturity/taxonomy#gateway-runtime)                                                                                                              | Core              | M4 Stable       | `Stable (81%)`       | `Alpha (69%)`        | `Stable (80%)`       | partial (12)      | 13    |
| [CLI](/maturity/taxonomy#cli)                                                                                                                                      | Core              | M4 Stable       | `Stable (83%)`       | `Beta (72%)`         | `Stable (80%)`       | partial (6)       | 7     |
| [Plugins](/maturity/taxonomy#plugins)                                                                                                                              | Core              | M3 Beta         | `Stable (82%)`       | `Stable (80%)`       | `Stable (81%)`       | partial (7)       | 9     |
| [Agent Runtime](/maturity/taxonomy#agent-runtime)                                                                                                                  | Core              | M3 Beta         | `Stable (80%)`       | `Alpha (69%)`        | `Stable (80%)`       | partial (6)       | 9     |
| [Session, memory, and context engine](/maturity/taxonomy#session-memory-and-context-engine)                                                                        | Core              | M3 Beta         | `Beta (74%)`         | `Alpha (66%)`        | `Beta (74%)`         | partial (6)       | 9     |
| [Channel framework](/maturity/taxonomy#channel-framework)                                                                                                          | Core              | M3 Beta         | `Beta (77%)`         | `Beta (74%)`         | `Beta (77%)`         | partial (5)       | 8     |
| [Security, auth, pairing, and secrets](/maturity/taxonomy#security-auth-pairing-and-secrets)                                                                       | Core              | M3 Beta         | `Stable (80%)`       | `Alpha (67%)`        | `Stable (80%)`       | partial (5)       | 6     |
| [Observability](/maturity/taxonomy#observability)                                                                                                                  | Core              | M3 Beta         | `Stable (80%)`       | `Beta (78%)`         | `Stable (80%)`       | partial (3)       | 5     |
| [Automation: cron, hooks, tasks, polling](/maturity/taxonomy#automation-cron-hooks-tasks-polling)                                                                  | Core              | M3 Beta         | `Beta (76%)`         | `Alpha (69%)`        | `Beta (76%)`         | none              | 6     |
| [Media understanding and media generation](/maturity/taxonomy#media-understanding-and-media-generation)                                                            | Core              | M2 Alpha        | `Beta (78%)`         | `Beta (70%)`         | `Beta (78%)`         | none              | 6     |
| [Voice and realtime talk](/maturity/taxonomy#voice-and-realtime-talk)                                                                                              | Core              | M2 Alpha        | `Beta (73%)`         | `Alpha (67%)`        | `Beta (73%)`         | none              | 6     |
| [Gateway Web App](/maturity/taxonomy#gateway-web-app)                                                                                                              | Core              | M3 Beta         | `Beta (79%)`         | `Beta (71%)`         | `Beta (79%)`         | none              | 6     |
| [TUI](/maturity/taxonomy#tui)                                                                                                                                      | Core              | M2 Alpha        | `Beta (76%)`         | `Beta (71%)`         | `Beta (76%)`         | none              | 5     |
| [ClawHub](/maturity/taxonomy#clawhub)                                                                                                                              | Core              | M2 Alpha        | `Beta (72%)`         | `Beta (73%)`         | `Beta (72%)`         | none              | 4     |
| [OpenClaw App SDK](/maturity/taxonomy#openclaw-app-sdk)                                                                                                            | Core              | M2 Alpha        | `Beta (75%)`         | `Beta (75%)`         | `Alpha (69%)`        | none              | 6     |
| [macOS Gateway host](/maturity/taxonomy#macos-gateway-host)                                                                                                        | Platform          | M4 Stable       | `Beta (75%)`         | `Beta (79%)`         | `Beta (75%)`         | none              | 7     |
| [macOS companion app](/maturity/taxonomy#macos-companion-app)                                                                                                      | Platform          | M3 Beta         | `Beta (71%)`         | `Alpha (66%)`        | `Beta (71%)`         | none              | 8     |
| [Linux Gateway host](/maturity/taxonomy#linux-gateway-host)                                                                                                        | Platform          | M4 Stable       | `Stable (80%)`       | `Beta (76%)`         | `Stable (80%)`       | partial (4)       | 5     |
| [Linux companion app](/maturity/taxonomy#linux-companion-app)                                                                                                      | Platform          | M0 Planned      | `Experimental (5%)`  | `Experimental (27%)` | `Experimental (5%)`  | none              | 5     |
| [Windows via WSL2](/maturity/taxonomy#windows-via-wsl2)                                                                                                            | Platform          | M3 Beta         | `Beta (72%)`         | `Alpha (69%)`        | `Beta (72%)`         | partial (5)       | 6     |
| [Native Windows](/maturity/taxonomy#native-windows)                                                                                                                | Platform          | M2 Alpha        | `Alpha (68%)`        | `Alpha (63%)`        | `Alpha (68%)`        | partial (1)       | 4     |
| [Native Windows companion app](/maturity/taxonomy#native-windows-companion-app)                                                                                    | Platform          | M0 Planned      | `Experimental (5%)`  | `Experimental (30%)` | `Experimental (5%)`  | none              | 5     |
| [Android app](/maturity/taxonomy#android-app)                                                                                                                      | Platform          | M2 Alpha        | `Alpha (65%)`        | `Alpha (62%)`        | `Alpha (65%)`        | none              | 7     |
| [iOS app](/maturity/taxonomy#ios-app)                                                                                                                              | Platform          | M1 Experimental | `Experimental (41%)` | `Experimental (45%)` | `Experimental (41%)` | none              | 8     |
| [watchOS companion surfaces](/maturity/taxonomy#watchos-companion-surfaces)                                                                                        | Platform          | M1 Experimental | `Experimental (45%)` | `Alpha (57%)`        | `Experimental (45%)` | none              | 5     |
| [Raspberry Pi and small Linux devices](/maturity/taxonomy#raspberry-pi-and-small-linux-devices)                                                                    | Platform          | M3 Beta         | `Beta (70%)`         | `Alpha (67%)`        | `Beta (70%)`         | none              | 4     |
| [Docker and Podman hosting](/maturity/taxonomy#docker-and-podman-hosting)                                                                                          | Platform          | M3 Beta         | `Beta (77%)`         | `Beta (73%)`         | `Beta (77%)`         | none              | 4     |
| [Kubernetes hosting](/maturity/taxonomy#kubernetes-hosting)                                                                                                        | Platform          | M2 Alpha        | `Alpha (50%)`        | `Beta (75%)`         | `Beta (74%)`         | none              | 4     |
| [Nix install path](/maturity/taxonomy#nix-install-path)                                                                                                            | Platform          | M1 Experimental | `Experimental (38%)` | `Experimental (45%)` | `Experimental (38%)` | none              | 5     |
| [Discord](/maturity/taxonomy#discord)                                                                                                                              | Channel           | M4 Stable       | `Beta (71%)`         | `Beta (71%)`         | `Beta (71%)`         | partial (4)       | 6     |
| [Telegram](/maturity/taxonomy#telegram)                                                                                                                            | Channel           | M3 Beta         | `Beta (75%)`         | `Beta (70%)`         | `Beta (75%)`         | full (5)          | 5     |
| [WhatsApp](/maturity/taxonomy#whatsapp)                                                                                                                            | Channel           | M3 Beta         | `Beta (76%)`         | `Beta (76%)`         | `Beta (76%)`         | none              | 5     |
| [Slack](/maturity/taxonomy#slack)                                                                                                                                  | Channel           | M3 Beta         | `Beta (70%)`         | `Alpha (68%)`        | `Beta (70%)`         | full (5)          | 5     |
| [iMessage and BlueBubbles](/maturity/taxonomy#imessage-and-bluebubbles)                                                                                            | Channel           | M3 Beta         | `Beta (71%)`         | `Beta (72%)`         | `Beta (71%)`         | none              | 5     |
| [Signal](/maturity/taxonomy#signal)                                                                                                                                | Channel           | M2 Alpha        | `Alpha (66%)`        | `Alpha (65%)`        | `Alpha (66%)`        | none              | 5     |
| [Google Chat](/maturity/taxonomy#google-chat)                                                                                                                      | Channel           | M2 Alpha        | `Alpha (57%)`        | `Alpha (53%)`        | `Alpha (57%)`        | none              | 5     |
| [Matrix](/maturity/taxonomy#matrix)                                                                                                                                | Channel           | M2 Alpha        | `Beta (72%)`         | `Alpha (68%)`        | `Beta (72%)`         | none              | 6     |
| [Microsoft Teams](/maturity/taxonomy#microsoft-teams)                                                                                                              | Channel           | M2 Alpha        | `Alpha (62%)`        | `Alpha (63%)`        | `Alpha (62%)`        | none              | 5     |
| [Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat](/maturity/taxonomy#mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat) | Channel           | M2 Alpha        | `Alpha (62%)`        | `Alpha (58%)`        | `Alpha (62%)`        | none              | 4     |
| [Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels](/maturity/taxonomy#feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels)    | Channel           | M2 Alpha        | `Experimental (43%)` | `Experimental (47%)` | `Experimental (43%)` | none              | 4     |
| [Voice Call channel](/maturity/taxonomy#voice-call-channel)                                                                                                        | Channel           | M1 Experimental | `Experimental (49%)` | `Alpha (58%)`        | `Experimental (49%)` | none              | 5     |
| [OpenAI and Codex provider path](/maturity/taxonomy#openai-and-codex-provider-path)                                                                                | Provider and tool | M3 Beta         | `Beta (78%)`         | `Beta (70%)`         | `Beta (78%)`         | partial (3)       | 5     |
| [Anthropic provider path](/maturity/taxonomy#anthropic-provider-path)                                                                                              | Provider and tool | M3 Beta         | `Stable (80%)`       | `Beta (74%)`         | `Stable (80%)`       | none              | 5     |
| [Google provider path](/maturity/taxonomy#google-provider-path)                                                                                                    | Provider and tool | M3 Beta         | `Beta (73%)`         | `Alpha (68%)`        | `Beta (73%)`         | none              | 5     |
| [OpenRouter provider path](/maturity/taxonomy#openrouter-provider-path)                                                                                            | Provider and tool | M3 Beta         | `Beta (75%)`         | `Alpha (66%)`        | `Beta (75%)`         | none              | 4     |
| [Local model providers: Ollama, vLLM, SGLang, LM Studio](/maturity/taxonomy#local-model-providers-ollama-vllm-sglang-lm-studio)                                    | Provider and tool | M2 Alpha        | `Beta (77%)`         | `Beta (74%)`         | `Beta (77%)`         | none              | 5     |
| [Long-tail hosted providers](/maturity/taxonomy#long-tail-hosted-providers)                                                                                        | Provider and tool | M2 Alpha        | `Alpha (64%)`        | `Alpha (60%)`        | `Alpha (64%)`        | none              | 3     |
| [Web search tools](/maturity/taxonomy#web-search-tools)                                                                                                            | Provider and tool | M3 Beta         | `Beta (79%)`         | `Beta (76%)`         | `Beta (79%)`         | none              | 4     |
| [Browser automation, exec, and sandbox tools](/maturity/taxonomy#browser-automation-exec-and-sandbox-tools)                                                        | Provider and tool | M3 Beta         | `Beta (79%)`         | `Beta (75%)`         | `Beta (79%)`         | partial (2)       | 3     |
| [Image, video, and music generation tools](/maturity/taxonomy#image-video-and-music-generation-tools)                                                              | Provider and tool | M2 Alpha        | `Beta (77%)`         | `Alpha (66%)`        | `Beta (77%)`         | none              | 5     |

> Last updated: 2026-06-19
