---
summary: "Ytor för användningsspårning och krav på autentiseringsuppgifter"
read_when:
  - Du kopplar ytor för leverantörers användning/kvoter
  - Du behöver förklara beteendet för användningsspårning eller autentiseringskrav
title: "Användningsspårning"
---

# Användningsspårning

## Vad det är

- Hämtar leverantörers användning/kvoter direkt från deras användningsendpoints.
- Inga uppskattade kostnader; endast de fönster som rapporteras av leverantören.

## Var det visas

- `/status` i chattar: emojirika statuskort med sessiontokens + beräknad kostnad (endast API-nyckel). Leverantörsanvändning visar för **nuvarande modellleverantör** när den är tillgänglig.
- `/usage off|tokens|full` i chattar: användningsfot per svar (OAuth visar endast tokens).
- `/usage cost` i chattar: lokal kostnadssammanfattning aggregerad från OpenClaw‑sessionsloggar.
- CLI: `openclaw status --usage` skriver ut en fullständig uppdelning per leverantör.
- CLI: `openclaw channels list` skriver ut samma användningsögonblicksbild tillsammans med leverantörskonfig (använd `--no-usage` för att hoppa över).
- macOS-menyrad: avsnittet ”Usage” under Context (endast om tillgängligt).

## Leverantörer + autentiseringsuppgifter

- **Anthropic (Claude)**: OAuth-tokens i autentiseringsprofiler.
- **GitHub Copilot**: OAuth-tokens i autentiseringsprofiler.
- **Gemini CLI**: OAuth-tokens i autentiseringsprofiler.
- **Antigravity**: OAuth-tokens i autentiseringsprofiler.
- **OpenAI Codex**: OAuth-tokens i autentiseringsprofiler (accountId används när det finns).
- **MiniMax**: API-nyckel (nyckel för kodningsplan; `MINIMAX_CODE_PLAN_KEY` eller `MINIMAX_API_KEY`); använder 5‑timmarsfönstret för kodningsplanen.
- **z.ai**: API-nyckel via env/konfig/autentiseringslager.

Användning döljs om inga matchande OAuth-/API‑autentiseringsuppgifter finns.
