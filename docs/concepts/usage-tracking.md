---
summary: "Usage tracking surfaces and credential requirements"
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: "Usage Tracking"
---

# Usage tracking

## What it is

- Pulls provider usage/quota directly from their usage endpoints.
- No estimated costs; only the provider-reported windows.

## Where it shows up

- `/status` in chats: status card with session tokens + estimated cost (API key only). Provider usage shows for the current model provider when available.
- Usage page in the app: provider quota panel with the same provider windows shown by `/quota` and CLI usage views.
- `/usage off|tokens|full` in chats: per-response usage footer (OAuth shows tokens only).
- `/usage cost` in chats: local cost summary aggregated from OpenClaw session logs.
- CLI: `openclaw status --usage` prints a full per-provider breakdown.
- CLI: `openclaw channels list` prints the same usage snapshot alongside provider config (use `--no-usage` to skip).
- macOS menu bar: "Usage" section under Context (only if available).

## Providers + credentials

- **Anthropic (Claude)**: OAuth tokens in auth profiles.
- **GitHub Copilot**: OAuth tokens in auth profiles.
- **Gemini CLI**: OAuth tokens in auth profiles.
- **Antigravity**: OAuth tokens in auth profiles.
- **OpenAI Codex**: OAuth tokens in auth profiles (accountId used when present).
- **MiniMax**: API key (coding plan key; `MINIMAX_CODE_PLAN_KEY` or `MINIMAX_API_KEY`); uses the 5-hour coding plan window.
- **Moonshot (Kimi)**: API key for Moonshot balance (`MOONSHOT_API_KEY` / provider key). Kimi billing windows may require a web auth token (`KIMI_BILLING_BEARER_TOKEN` or `KIMI_WEB_AUTH_TOKEN`) from env/config auth vars.
- **z.ai**: API key via env/config/auth store.

Usage is hidden if no matching OAuth/API credentials exist.
