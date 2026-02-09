---
summary: "Mga surface ng pagsubaybay sa paggamit at mga kinakailangan sa kredensyal"
read_when:
  - Ikaw ay nagwi-wire ng mga surface ng paggamit/quota ng provider
  - Kailangan mong ipaliwanag ang gawi ng usage tracking o mga kinakailangan sa auth
title: "Pagsubaybay sa Paggamit"
---

# Pagsubaybay sa paggamit

## Ano ito

- Kinukuha ang paggamit/quota ng provider direkta mula sa kanilang mga usage endpoint.
- Walang tinatayang gastos; tanging mga window na iniulat ng provider.

## Saan ito lumalabas

- `/status` in chats: emoji‑rich status card with session tokens + estimated cost (API key only). Provider usage shows for the **current model provider** when available.
- `/usage off|tokens|full` sa mga chat: per-response na footer ng paggamit (OAuth ay nagpapakita ng tokens lamang).
- `/usage cost` sa mga chat: lokal na buod ng gastos na pinagsama-sama mula sa mga log ng session ng OpenClaw.
- CLI: `openclaw status --usage` nagpi-print ng kumpletong breakdown bawat provider.
- CLI: `openclaw channels list` nagpi-print ng parehong snapshot ng paggamit kasama ang config ng provider (gamitin ang `--no-usage` para laktawan).
- macOS menu bar: seksyong “Usage” sa ilalim ng Context (kapag available lamang).

## Mga provider + kredensyal

- **Anthropic (Claude)**: mga OAuth token sa mga auth profile.
- **GitHub Copilot**: mga OAuth token sa mga auth profile.
- **Gemini CLI**: mga OAuth token sa mga auth profile.
- **Antigravity**: mga OAuth token sa mga auth profile.
- **OpenAI Codex**: mga OAuth token sa mga auth profile (ginagamit ang accountId kapag present).
- **MiniMax**: API key (coding plan key; `MINIMAX_CODE_PLAN_KEY` o `MINIMAX_API_KEY`); gumagamit ng 5‑oras na window ng coding plan.
- **z.ai**: API key sa pamamagitan ng env/config/auth store.

Nakatago ang paggamit kung walang tumutugmang OAuth/API na kredensyal.
