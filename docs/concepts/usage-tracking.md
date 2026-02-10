---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Usage tracking surfaces and credential requirements"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are wiring provider usage/quota surfaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to explain usage tracking behavior or auth requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Usage Tracking"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Usage tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pulls provider usage/quota directly from their usage endpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No estimated costs; only the provider-reported windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where it shows up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` in chats: emoji‑rich status card with session tokens + estimated cost (API key only). Provider usage shows for the **current model provider** when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage off|tokens|full` in chats: per-response usage footer (OAuth shows tokens only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage cost` in chats: local cost summary aggregated from OpenClaw session logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw status --usage` prints a full per-provider breakdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw channels list` prints the same usage snapshot alongside provider config (use `--no-usage` to skip).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS menu bar: “Usage” section under Context (only if available).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Providers + credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Anthropic (Claude)**: OAuth tokens in auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GitHub Copilot**: OAuth tokens in auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gemini CLI**: OAuth tokens in auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Antigravity**: OAuth tokens in auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenAI Codex**: OAuth tokens in auth profiles (accountId used when present).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **MiniMax**: API key (coding plan key; `MINIMAX_CODE_PLAN_KEY` or `MINIMAX_API_KEY`); uses the 5‑hour coding plan window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **z.ai**: API key via env/config/auth store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usage is hidden if no matching OAuth/API credentials exist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
