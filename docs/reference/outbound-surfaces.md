---
title: Outbound HTTP Surfaces
---

# Outbound HTTP Surfaces

Audit of all gateway outbound HTTP call sites, classified by whether they flow through the `fetchWithSsrFGuard` SSRF chokepoint. "Guarded" means the request passes through `fetchWithSsrFGuard`, which enforces DNS blocklist checks and IP-range pinning before any network call is made.

Audit date: 2026-03-08.

## Agent Tools

Highest-risk category: the AI agent controls the target URL.

| Surface              | Source                                  | Guarded | Notes                                                                   |
| -------------------- | --------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Web Fetch            | `src/agents/tools/web-fetch.ts`         | Yes     | SSRF chokepoint (agent-controlled URL)                                  |
| Web Search redirects | `src/agents/tools/web-fetch.ts`         | Yes     | SSRF chokepoint (agent-controlled URL)                                  |
| Skills download      | `src/agents/skills-install-download.ts` | Yes     | SSRF chokepoint (agent-controlled URL)                                  |
| Firecrawl fallback   | `src/agents/tools/web-fetch.ts`         | No      | Hardcoded Firecrawl API endpoint (agent-controlled URL in request body) |

## Channel APIs

Vendor-fixed endpoints called with operator-provided tokens.

| Surface           | Source                              | Guarded | Notes                                                   |
| ----------------- | ----------------------------------- | ------- | ------------------------------------------------------- |
| Telegram Bot API  | `src/telegram/bot.ts`               | No      | grammy SDK, hardcoded api.telegram.org                  |
| Discord REST API  | `src/discord/monitor/rest-fetch.ts` | No      | Bare fetch, hardcoded Discord API                       |
| Slack Web API     | `src/slack/client.ts`               | No      | SDK-managed, hardcoded Slack API                        |
| Slack file upload | `src/slack/send.ts`                 | Yes     | SSRF chokepoint via withTrustedEnvProxyGuardedFetchMode |
| Signal            | `src/signal/`                       | No      | No outbound HTTP (local subprocess)                     |
| iMessage          | `src/imessage/client.ts`            | No      | No outbound HTTP (local subprocess)                     |

## Provider APIs

Operator-configured endpoints for LLM and service providers.

| Surface              | Source                                     | Guarded | Notes                               |
| -------------------- | ------------------------------------------ | ------- | ----------------------------------- |
| Ollama API           | `src/agents/models-config.providers.ts`    | No      | Bare fetch, operator-configured URL |
| TTS providers        | `src/tts/tts-core.ts`                      | No      | Bare fetch, operator-configured URL |
| Vercel AI Gateway    | `src/agents/vercel-ai-gateway.ts`          | No      | Bare fetch, hardcoded endpoint      |
| Venice models        | `src/agents/venice-models.ts`              | No      | Bare fetch, hardcoded endpoint      |
| HuggingFace models   | `src/agents/huggingface-models.ts`         | No      | Bare fetch, hardcoded endpoint      |
| Kilocode models      | `src/agents/kilocode-models.ts`            | No      | Bare fetch, hardcoded endpoint      |
| OpenCode Zen models  | `src/agents/opencode-zen-models.ts`        | No      | Bare fetch, hardcoded endpoint      |
| Minimax VLM          | `src/agents/minimax-vlm.ts`                | No      | Bare fetch, operator token          |
| PDF native providers | `src/agents/tools/pdf-native-providers.ts` | No      | Bare fetch, operator-configured     |
| Bedrock discovery    | `src/agents/bedrock-discovery.ts`          | No      | AWS SDK pattern                     |

## Media Pipeline

| Surface                   | Source                                        | Guarded | Notes                                          |
| ------------------------- | --------------------------------------------- | ------- | ---------------------------------------------- |
| Media fetch (input files) | `src/media/input-files.ts`                    | Yes     | SSRF chokepoint                                |
| Media fetch (general)     | `src/media/fetch.ts`                          | Yes     | SSRF chokepoint via withStrictGuardedFetchMode |
| Media understanding       | `src/media-understanding/providers/shared.ts` | Yes     | SSRF chokepoint                                |
| Camera node fetch         | `src/cli/nodes-camera.ts`                     | Yes     | SSRF chokepoint                                |

## Infrastructure

| Surface               | Source                          | Guarded | Notes           |
| --------------------- | ------------------------------- | ------- | --------------- |
| Cron webhook delivery | `src/gateway/server-cron.ts`    | Yes     | SSRF chokepoint |
| Remote memory HTTP    | `src/memory/remote-http.ts`     | Yes     | SSRF chokepoint |
| Gateway probe         | `src/gateway/probe.ts`          | No      | Localhost probe |
| Browser sandbox       | `src/agents/sandbox/browser.ts` | No      | Localhost       |

## Extensions (Sample)

Representative sample of extension outbound surfaces. The plugin SDK re-exports `fetchWithSsrFGuard`, so extensions that use the SDK helper get SSRF guarding automatically.

| Surface                | Source                                          | Guarded | Notes                           |
| ---------------------- | ----------------------------------------------- | ------- | ------------------------------- |
| Matrix client config   | `extensions/matrix/src/matrix/client/config.ts` | Yes     | Plugin-sdk fetchWithSsrFGuard   |
| Matrix directory       | `extensions/matrix/src/directory-live.ts`       | No      | Bare fetch, operator homeserver |
| MS Teams Graph API     | `extensions/msteams/src/graph.ts`               | No      | Bare fetch, hardcoded MS Graph  |
| MS Teams attachments   | `extensions/msteams/src/attachments/graph.ts`   | Yes     | Plugin-sdk fetchWithSsrFGuard   |
| Feishu streaming cards | `extensions/feishu/src/streaming-card.ts`       | Yes     | Plugin-sdk fetchWithSsrFGuard   |
