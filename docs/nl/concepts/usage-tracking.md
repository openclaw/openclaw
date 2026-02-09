---
summary: "Volgoppervlakken voor gebruik en certificaatvereisten"
read_when:
  - Je koppelt provider-gebruiks-/quotoppervlakken
  - Je moet het gedrag van gebruikstracking of authenticatievereisten uitleggen
title: "Gebruik volgen"
---

# Gebruik volgen

## Wat het is

- Haalt provider-gebruik/quotum direct op via hun gebruiksendpoints.
- Geen geschatte kosten; alleen door de provider gerapporteerde perioden.

## Waar het verschijnt

- `/status` in chats: emoji‑rijke statuskaart met sessietokens + geschatte kosten (alleen API-sleutel). Providergebruik wordt getoond voor de **huidige modelprovider** wanneer beschikbaar.
- `/usage off|tokens|full` in chats: per-antwoord gebruiksfooter (OAuth toont alleen tokens).
- `/usage cost` in chats: lokale kostensamenvatting, geaggregeerd uit OpenClaw-sessielogs.
- CLI: `openclaw status --usage` toont een volledige uitsplitsing per provider.
- CLI: `openclaw channels list` toont dezelfde gebruikssnapshot naast de providerconfiguratie (gebruik `--no-usage` om over te slaan).
- macOS-menubalk: sectie “Usage” onder Context (alleen indien beschikbaar).

## Providers + inloggegevens

- **Anthropic (Claude)**: OAuth-tokens in auth-profielen.
- **GitHub Copilot**: OAuth-tokens in auth-profielen.
- **Gemini CLI**: OAuth-tokens in auth-profielen.
- **Antigravity**: OAuth-tokens in auth-profielen.
- **OpenAI Codex**: OAuth-tokens in auth-profielen (accountId wordt gebruikt indien aanwezig).
- **MiniMax**: API-sleutel (coding plan-sleutel; `MINIMAX_CODE_PLAN_KEY` of `MINIMAX_API_KEY`); gebruikt het 5‑uur-venster van het coding plan.
- **z.ai**: API-sleutel via env/config/auth store.

Gebruik wordt verborgen als er geen overeenkomende OAuth-/API-inloggegevens bestaan.
