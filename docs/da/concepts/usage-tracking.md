---
summary: "Overflader for brugsregistrering og krav til legitimationsoplysninger"
read_when:
  - Du kobler udbyderes brugs-/kvoteoverflader
  - Du skal forklare adfærd for brugsregistrering eller autentificeringskrav
title: "Brugsregistrering"
---

# Brugsregistrering

## Hvad det er

- Henter udbydernes brug/kvoter direkte fra deres brugsendepunkter.
- Ingen estimerede omkostninger; kun de vinduer, som udbyderen rapporterer.

## Hvor det vises

- `/status` i chats: emoji-rige statuskort med sessionstokens + anslåede omkostninger (API-nøgle kun). Brug af udbyder viser for **nuværende model udbyderen** når det er tilgængeligt.
- `/usage off|tokens|full` i chats: brugsfodnote pr. svar (OAuth viser kun tokens).
- `/usage cost` i chats: lokal omkostningsoversigt aggregeret fra OpenClaw-sessionslogge.
- CLI: `openclaw status --usage` udskriver en fuld opdeling pr. udbyder.
- CLI: `openclaw channels list` udskriver det samme brugsøjebliksbillede sammen med udbyderkonfiguration (brug `--no-usage` for at springe over).
- macOS-menulinje: afsnittet “Usage” under Context (kun hvis tilgængeligt).

## Udbydere + legitimationsoplysninger

- **Anthropic (Claude)**: OAuth-tokens i godkendelsesprofiler.
- **GitHub Copilot**: OAuth-tokens i godkendelsesprofiler.
- **Gemini CLI**: OAuth-tokens i godkendelsesprofiler.
- **Antigravity**: OAuth-tokens i godkendelsesprofiler.
- **OpenAI Codex**: OAuth-tokens i godkendelsesprofiler (accountId bruges, når det er til stede).
- **MiniMax**: API-nøgle (coding plan-nøgle; `MINIMAX_CODE_PLAN_KEY` eller `MINIMAX_API_KEY`); bruger 5-timers coding plan-vinduet.
- **z.ai**: API-nøgle via env/konfiguration/godkendelseslager.

Brug er skjult, hvis der ikke findes matchende OAuth-/API-legitimationsoplysninger.
